/**
 * AES-GCM only. Unauthenticated modes were removed: without a tag, a modified frame
 * decodes into noise instead of being rejected, which is indistinguishable from a bug.
 */
export type CipherAlgorithm = "AES-GCM";

/**
 * `"sfu"` leaves the codec payload header readable so a media server can still classify
 * and route frames. `"full"` encrypts the entire frame — only safe when nothing between
 * the peers parses the media (relayed/P2P sessions).
 */
export type HeaderPolicy = "sfu" | "full";

export type CipherOp = "encrypt" | "decrypt";
export type CipherKind = "audio" | "video";

/** A single sender or receiver being transformed. */
export type CipherStream = {
  id: number;
  op: CipherOp;
  kind: CipherKind;
  /** Short public tag for the key in use, so both ends can be compared at a glance. */
  keyId: string;
  algorithm: CipherAlgorithm;
  senderId: string;
  fullFrame: boolean;
  frames: number;
  inBytes: number;
  outBytes: number;
  keyFrames: number;
  /** Frames passed through untouched (too short to seal, or not sealed by us). */
  passthrough: number;
  dropped: number;
  /** Frames sealed with a key this endpoint does not hold. */
  mismatched: number;
  /** Frames rejected by the sliding-window replay check. */
  replayed: number;
  /** Frames from a generation that has already been ratcheted away. */
  staleGeneration: number;
  /** Frames that failed authentication — a tampered or corrupt frame. */
  failed: number;
  /** The generation this endpoint is currently sending under. */
  generation: number;
  /** Why frames were dropped, keyed by reason. Useful when a tile stays blank. */
  reasons: Record<string, number>;
  cryptoMs: number;
  open: boolean;
  startedAt: number;
};

export type CipherLogLevel = "info" | "frame" | "warn" | "error";

export type CipherLogEvent =
  | {
      type: "open";
      id: number;
      op: CipherOp;
      kind: CipherKind;
      keyId: string;
      algorithm: CipherAlgorithm;
      senderId: string;
      fullFrame: boolean;
    }
  | { type: "ratcheted"; generation: number }
  | { type: "close"; id: number; op: CipherOp; kind: CipherKind }
  | {
      type: "frame";
      id: number;
      op: CipherOp;
      kind: CipherKind;
      seq: number;
      frameType?: string;
      inBytes: number;
      outBytes: number;
      /** Bytes of codec header deliberately left readable so the SFU can still route the frame. */
      headerBytes: number;
      clearHex: string;
      beforeHex: string;
      afterHex: string;
      generation: number;
      counter: number;
      ms: number;
    }
  | { type: "key-mismatch"; id: number; kind: CipherKind; saw: string; want: string }
  | { type: "error"; id: number; op: CipherOp; kind: CipherKind; message: string };

export type CipherLogEntry = {
  seq: number;
  at: number;
  level: CipherLogLevel;
  text: string;
  detail?: string;
  event: CipherLogEvent;
};

export type KeyMismatch = { kind: CipherKind; saw: string; want: string };

export type FrameCipherOptions = {
  /**
   * 32 raw bytes shared by everyone in the call. Used as HKDF root material, never
   * directly as an AES key: per-sender, per-generation keys are derived from it.
   */
  key: Uint8Array;
  /**
   * 4 bytes identifying this participant, unique within the call. Two participants
   * sharing an id would share a key and a counter space, so pass a stable value derived
   * from your signalling identity (a Vonage connectionId, say) when you have one.
   * Defaults to random.
   */
  senderId?: Uint8Array;
  /** Default `"sfu"`. Use `"full"` only when no media server parses your frames. */
  headerPolicy?: HeaderPolicy;
  /**
   * Discard the root secret once generation 0 is derived, and forget generations older
   * than the grace window. Makes the ratchet one-way, so ratcheting past a generation
   * permanently destroys the ability to read its frames. Default true.
   */
  forwardSecrecy?: boolean;
  /** Generations kept readable behind the current one, for frames in flight during a rekey. Default 2. */
  generationGrace?: number;
  /**
   * Serve the worker yourself instead of letting the SDK build a blob URL.
   * Needed under a Content-Security-Policy that forbids `worker-src blob:`.
   */
  workerUrl?: string | URL;
  /** Frames logged in full per stream before falling back to counters. Default 3. */
  sampleFrames?: number;
  /** Log every frame. Costs one postMessage per frame. Default false. */
  verbose?: boolean;
  /** Mirror the log to the browser console. Default true in development. */
  console?: boolean;
  /**
   * Vonage's SDK calls setParameters with fields Chrome rejects; a shim merges them into
   * the live parameters instead. Harmless elsewhere. Default true.
   */
  patchSetParameters?: boolean;
  onLog?: (entry: CipherLogEntry) => void;
  onKeyMismatch?: (info: KeyMismatch) => void;
};

export type FrameCipherSupport = { supported: boolean; reason?: string };
