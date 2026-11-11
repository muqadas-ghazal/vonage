import { CipherLog, EMPTY_SNAPSHOT, type CipherSnapshot } from "./log.js";
import { WORKER_SOURCE } from "./worker-source.js";
import type {
  CipherKind,
  CipherState,
  HeaderPolicy,
  CipherOp,
  CipherStream,
  FrameCipherOptions,
  FrameCipherSupport,
  KeyMismatch,
} from "./types.js";

const MARK = "__frameCipherArmed";

/** Narrow views of the two description setters; lib.dom's deprecated callback overloads get in the way. */
type SetLocal = (this: RTCPeerConnection, description?: RTCLocalSessionDescriptionInit) => Promise<void>;
type SetRemote = (this: RTCPeerConnection, description: RTCSessionDescriptionInit) => Promise<void>;

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
}

/** Whether this runtime can transform encoded frames at all. */
export function frameCipherSupport(): FrameCipherSupport {
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
    return {
      supported: false,
      reason:
        "React Native has no WebRTC Encoded Transform, so frame-level encryption cannot " +
        "run here. Use Vonage's own E2EE instead: pass `encryptionSecret` to <OTSession> " +
        "from opentok-react-native. The key helpers in @booth/frame-cipher/keys work on " +
        "React Native and can generate and share that secret.",
    };
  }
  if (typeof window === "undefined") {
    return { supported: false, reason: "No window: frame transforms only run in a browser." };
  }
  if (typeof RTCPeerConnection !== "function") {
    return { supported: false, reason: "This runtime has no RTCPeerConnection." };
  }
  if (typeof RTCRtpScriptTransform !== "function") {
    const reactNative =
      typeof navigator !== "undefined" && navigator.product === "ReactNative";
    return {
      supported: false,
      reason: reactNative
        ? "React Native has no WebRTC Encoded Transform, so frame-level encryption cannot " +
          "run here. Use Vonage's own E2EE instead: pass `encryptionSecret` to <OTSession> " +
          "from opentok-react-native. The key helpers in @booth/frame-cipher/keys work on " +
          "React Native and can generate and share that secret."
        : "This browser has no RTCRtpScriptTransform (WebRTC Encoded Transform). " +
          "Needs Chrome/Edge 141+, Firefox 117+, or Safari 15.4+.",
    };
  }
  if (typeof Worker !== "function") {
    return { supported: false, reason: "This runtime has no Worker." };
  }
  return { supported: true };
}

export function isFrameCipherSupported(): boolean {
  return frameCipherSupport().supported;
}

export type FrameCipher = {
  /**
   * Patches RTCPeerConnection so every sender and receiver is transformed automatically.
   * Call this BEFORE the video SDK is imported: SDKs capture these methods as they load.
   */
  install(): void;
  /** Restores the original RTCPeerConnection methods. Existing transforms keep running. */
  uninstall(): void;
  /** Attach by hand, for SDKs that hand you the peer connection. */
  armPeerConnection(pc: RTCPeerConnection): void;
  protectSender(sender: RTCRtpSender, kind?: CipherKind): void;
  protectReceiver(receiver: RTCRtpReceiver, kind?: CipherKind): void;
  /** Log every frame rather than the first few of each stream. */
  setVerbose(value: boolean): void;
  isVerbose(): boolean;
  getStreams(): CipherStream[];
  /**
   * Turn encryption on with this secret, or pass null to go back to sending in the clear.
   * Takes effect on the next frame — no renegotiation, no interruption to the call.
   */
  setKey(key: Uint8Array | null): void;
  /** Seal outgoing frames or not. Receiving is unaffected: a held key always decrypts. */
  setSending(value: boolean): void;
  /** What the UI needs: do we hold a key, are we sealing, and are remote streams locked. */
  state(): CipherState;
  /** The state of the stream carrying a given media track, for marking one tile. */
  trackState(trackId: string): "secured" | "locked" | "plaintext" | "unknown";
  /**
   * Advance the key ratchet. Every participant must ratchet for the call to keep working,
   * so drive this from a membership event all of them observe (someone joined or left).
   * With forwardSecrecy on, frames from generations older than the grace window become
   * permanently unreadable — which is the point.
   */
  ratchet(): void;
  /** The generation this endpoint is sending under. */
  generation(): number;
  /** The short key tag from the worker, once a stream has opened. Compare across participants. */
  keyId(): string | null;
  /** The 4-byte id this participant seals frames with. */
  senderId(): string;
  snapshot(): CipherSnapshot;
  subscribe(listener: () => void): () => void;
  /** Tears down the worker. Call on unmount. */
  destroy(): void;
};

export function createFrameCipher(options: FrameCipherOptions): FrameCipher {
  const support = frameCipherSupport();
  if (!support.supported) throw new Error(`frame-cipher: ${support.reason}`);
  if (options.key && options.key.byteLength !== 32) {
    throw new Error(`frame-cipher: key must be 32 bytes, got ${options.key.byteLength}.`);
  }

  const sampleFrames = options.sampleFrames ?? 3;
  const headerPolicy: HeaderPolicy = options.headerPolicy ?? "sfu";
  const fullFrame = headerPolicy === "full";
  const senderIdBytes = options.senderId ?? crypto.getRandomValues(new Uint8Array(4));
  if (senderIdBytes.byteLength !== 4) {
    throw new Error(`frame-cipher: senderId must be 4 bytes, got ${senderIdBytes.byteLength}.`);
  }
  const senderIdHex = [...senderIdBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const scheduleId = crypto.randomUUID();
  const useConsole =
    options.console ?? (typeof process === "undefined" || process.env?.NODE_ENV !== "production");
  const log = new CipherLog(useConsole);

  let verbose = options.verbose ?? false;
  let lastState = "";
  let generation = 0;
  let nextStreamId = 1;
  let worker: Worker | null = null;
  let workerObjectUrl: string | null = null;
  let destroyed = false;
  let mismatchSeen = false;

  let rootSecret: ArrayBuffer | null = options.key ? toArrayBuffer(options.key) : null;
  let sending = Boolean(options.key) && options.sending !== false;
  let reportedKeyId: string | null = null;

  function ensureWorker(): Worker {
    if (worker) return worker;
    if (options.workerUrl) {
      worker = new Worker(options.workerUrl, { type: "classic" });
    } else {
      const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
      workerObjectUrl = URL.createObjectURL(blob);
      worker = new Worker(workerObjectUrl);
    }
    worker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "cipher-ratcheted") {
        generation = Number(data.generation);
        return;
      }
      if (data.type === "cipher-open" && typeof data.keyId === "string") {
        reportedKeyId = data.keyId;
      }
      if (data.type === "cipher-key-set") {
        reportedKeyId = typeof data.keyId === "string" ? data.keyId : null;
      }
      const entry = log.handle(data);
      announceState();
      if (!entry) return;
      options.onLog?.(entry);
      if (entry.event.type === "key-mismatch" && !mismatchSeen) {
        mismatchSeen = true;
        const info: KeyMismatch = {
          kind: entry.event.kind,
          saw: entry.event.saw,
          want: entry.event.want,
        };
        options.onKeyMismatch?.(info);
      }
    });
    // Any rekey raised before the worker existed is replayed as a target.
    if (generation > 0) worker.postMessage({ type: "cipher-ratchet", scheduleId, target: generation });
    return worker;
  }

  function attach(op: CipherOp, endpoint: RTCRtpSender | RTCRtpReceiver, hinted?: CipherKind) {
    if (destroyed) return;
    const kind = endpoint.track?.kind ?? hinted;
    if (kind !== "audio" && kind !== "video") return;
    if (endpoint.transform) return;
    try {
      const streamId = nextStreamId;
      nextStreamId += 1;
      // The receiver's track id is the only handle shared with the video SDK's own
      // objects, so it is what lets a tile ask about its own stream.
      const trackId = endpoint.track?.id ?? "";
      endpoint.transform = new RTCRtpScriptTransform(ensureWorker(), {
        op,
        kind,
        streamId,
        trackId,
        scheduleId,
        senderId: toArrayBuffer(senderIdBytes),
        fullFrame,
        generation,
        sending,
        forwardSecrecy: options.forwardSecrecy !== false,
        generationGrace: options.generationGrace ?? 2,
        sampleFrames,
        verbose,
        rootSecret: rootSecret ? rootSecret.slice(0) : null,
      });
    } catch {
      // A sender can refuse a transform until the connection is further along.
      // armPeerConnection runs again on each negotiation step, so this retries.
    }
  }

  function armPeerConnection(pc: RTCPeerConnection) {
    if (destroyed) return;
    const marked = pc as RTCPeerConnection & { [MARK]?: boolean };
    if (!marked[MARK]) {
      marked[MARK] = true;
      pc.addEventListener("track", (event) => {
        if (event.receiver) attach("decrypt", event.receiver);
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") armPeerConnection(pc);
      });
    }
    for (const sender of pc.getSenders()) attach("encrypt", sender);
    for (const receiver of pc.getReceivers()) attach("decrypt", receiver);
  }

  type Patches = {
    addTrack: RTCPeerConnection["addTrack"];
    addTransceiver: RTCPeerConnection["addTransceiver"];
    setLocalDescription: SetLocal;
    setRemoteDescription: SetRemote;
    setParameters?: RTCRtpSender["setParameters"];
  };
  let patches: Patches | null = null;

  /** Publishes the state only when it differs, so stats flushes are cheap. */
  function announceState() {
    if (!options.onStateChange) return;
    const next = describeState();
    const encoded = JSON.stringify(next);
    if (encoded === lastState) return;
    lastState = encoded;
    options.onStateChange(next);
  }

  /** What is happening on the stream carrying this media track, right now. */
  function trackState(trackId: string): "secured" | "locked" | "plaintext" | "unknown" {
    const match = log
      .snapshot()
      .streams.filter((s) => s.trackId === trackId && s.op === "decrypt" && s.open)
      .filter((s) => s.recentSecured + s.recentLocked + s.recentPlaintext > 0);
    if (match.length === 0) return "unknown";
    if (match.some((s) => s.recentSecured > 0)) return "secured";
    if (match.some((s) => s.recentLocked > 0)) return "locked";
    return "plaintext";
  }

  function describeState(): CipherState {
    const streams = log.snapshot().streams;
    const inbound = streams.filter((stream) => stream.op === "decrypt" && stream.open);
    const active = inbound.filter(
      (s) => s.recentSecured + s.recentLocked + s.recentPlaintext > 0,
    );
    return {
      hasKey: rootSecret !== null,
      sending,
      keyId: reportedKeyId,
      generation,
      /**
       * Judged on the latest reporting window, not on totals: a stream that decrypted
       * fine earlier can become locked later, and that has to surface rather than
       * leaving the picture silently frozen.
       *
       * Only streams that actually carried a frame in that window count. Renegotiation
       * leaves idle transforms behind, and counting those as "in the clear" would warn
       * about plaintext on a call where every live stream is sealed.
       */
      lockedStreams: active.filter((s) => s.recentLocked > 0 && s.recentSecured === 0).length,
      securedStreams: active.filter((s) => s.recentSecured > 0).length,
      plaintextStreams: active.filter((s) => s.recentPlaintext > 0 && s.recentSecured === 0).length,
    };
  }

  function install() {
    if (patches || destroyed) return;
    const peer = RTCPeerConnection.prototype;
    patches = {
      addTrack: peer.addTrack,
      addTransceiver: peer.addTransceiver,
      setLocalDescription: peer.setLocalDescription as SetLocal,
      setRemoteDescription: peer.setRemoteDescription as SetRemote,
    };
    const original = patches;

    peer.addTrack = function (track, ...streams) {
      const sender = original.addTrack.call(this, track, ...streams);
      attach("encrypt", sender, track.kind === "audio" ? "audio" : "video");
      return sender;
    };

    peer.addTransceiver = function (trackOrKind, init) {
      const transceiver = original.addTransceiver.call(this, trackOrKind, init);
      const raw = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
      const kind: CipherKind = raw === "audio" ? "audio" : "video";
      const direction = init?.direction ?? transceiver.direction;
      if (direction === "sendrecv" || direction === "sendonly") {
        attach("encrypt", transceiver.sender, kind);
      }
      if (direction === "sendrecv" || direction === "recvonly") {
        attach("decrypt", transceiver.receiver, kind);
      }
      return transceiver;
    };

    peer.setLocalDescription = function (this: RTCPeerConnection, description?: RTCLocalSessionDescriptionInit) {
      return Promise.resolve(original.setLocalDescription.call(this, description)).then((value) => {
        armPeerConnection(this);
        return value;
      });
    } as typeof peer.setLocalDescription;

    peer.setRemoteDescription = function (this: RTCPeerConnection, description: RTCSessionDescriptionInit) {
      return Promise.resolve(original.setRemoteDescription.call(this, description)).then((value) => {
        armPeerConnection(this);
        return value;
      });
    } as typeof peer.setRemoteDescription;

    if (options.patchSetParameters ?? true) {
      const originalSetParameters = RTCRtpSender.prototype.setParameters;
      patches.setParameters = originalSetParameters;
      RTCRtpSender.prototype.setParameters = function (requested) {
        const current = this.getParameters();
        if (requested.encodings && current.encodings) {
          for (let index = 0; index < current.encodings.length; index += 1) {
            const next = requested.encodings[index];
            if (next) Object.assign(current.encodings[index], next);
          }
        }
        if (requested.degradationPreference) {
          current.degradationPreference = requested.degradationPreference;
        }
        return originalSetParameters.call(this, current);
      };
    }
  }

  function uninstall() {
    if (!patches) return;
    const peer = RTCPeerConnection.prototype;
    peer.addTrack = patches.addTrack;
    peer.addTransceiver = patches.addTransceiver;
    peer.setLocalDescription = patches.setLocalDescription as typeof peer.setLocalDescription;
    peer.setRemoteDescription = patches.setRemoteDescription as typeof peer.setRemoteDescription;
    if (patches.setParameters) RTCRtpSender.prototype.setParameters = patches.setParameters;
    patches = null;
  }

  return {
    install,
    uninstall,
    armPeerConnection,
    protectSender: (sender, kind) => attach("encrypt", sender, kind),
    protectReceiver: (receiver, kind) => attach("decrypt", receiver, kind),
    setVerbose(value) {
      verbose = value;
      worker?.postMessage({ type: "cipher-verbose", value });
    },
    isVerbose: () => verbose,
    getStreams: () => log.snapshot().streams,
    setKey(key) {
      if (destroyed) return;
      if (key && key.byteLength !== 32) {
        throw new Error(`frame-cipher: key must be 32 bytes, got ${key.byteLength}.`);
      }
      rootSecret = key ? toArrayBuffer(key) : null;
      sending = Boolean(key) && options.sending !== false;
      generation = 0;
      worker?.postMessage({
        type: "cipher-key",
        scheduleId,
        rootSecret: rootSecret ? rootSecret.slice(0) : null,
        sending,
      });
      announceState();
    },
    setSending(value) {
      if (destroyed) return;
      sending = value && rootSecret !== null;
      worker?.postMessage({ type: "cipher-sending", scheduleId, value: sending });
      announceState();
    },
    state: describeState,
    trackState,
    ratchet() {
      if (destroyed) return;
      generation += 1;
      // Sent as a target rather than a nudge, and replayed when the worker first appears,
      // so a rekey raised before any track exists is never silently lost.
      worker?.postMessage({ type: "cipher-ratchet", scheduleId, target: generation });
    },
    generation: () => generation,
    senderId: () => senderIdHex,
    keyId: () => reportedKeyId,
    snapshot: () => (destroyed ? EMPTY_SNAPSHOT : log.snapshot()),
    subscribe: log.subscribe,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      uninstall();
      worker?.postMessage({ type: "cipher-shutdown", scheduleId });
      worker?.terminate();
      worker = null;
      if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
      workerObjectUrl = null;
    },
  };
}
