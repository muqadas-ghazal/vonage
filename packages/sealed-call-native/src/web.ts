/**
 * The call page's half of the bridge. Import this in the web app, not in React Native.
 *
 * It takes the app's cipher functions as arguments rather than importing them, so this
 * file stays free of any dependency on a particular app's wiring — and so it can be
 * unit-tested without a browser.
 */

import {
  PROTOCOL_VERSION,
  type HostMessage,
  type PageMessage,
  type SealedState,
  type SealedTrack,
} from "./protocol";

export type PageBridgeHooks = {
  /** False on a WebView with no `RTCRtpScriptTransform`; `reason` is shown to the user. */
  support(): { supported: boolean; reason?: string };
  /** Stretch a passphrase and turn encryption on. */
  enablePassphrase(value: string): Promise<void>;
  /** Turn encryption on with a key the user supplied directly. */
  enableRawKey(value: string): void;
  forgetKey(): void;
  setVerbose(value: boolean): void;
  /** The current call state, read on demand. */
  snapshot(): Omit<SealedState, "status" | "tracks">;
  /** Per-tile states, keyed by media track id. */
  tracks(): SealedTrack[];
  /** Fires whenever anything above changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  fingerprint(value: string, mode: "passphrase" | "raw"): Promise<string>;
  /** Run when the app returns to the foreground. Used to re-acquire the camera. */
  onResume?(): void | Promise<void>;
};

type Host = { postMessage(data: string): void };

function host(): Host | null {
  const value = (globalThis as { ReactNativeWebView?: Host }).ReactNativeWebView;
  return value && typeof value.postMessage === "function" ? value : null;
}

/** True when this page is running inside the React Native shell. */
export function isHosted(): boolean {
  return host() !== null;
}

/**
 * Derives the single status the native UI shows from the per-stream counts.
 *
 * `locked` outranks `sealed` on purpose: if any peer is sending something we cannot open,
 * that is the fact the user needs, even when other peers are fine.
 */
function statusFor(state: Omit<SealedState, "status" | "tracks">, supported: boolean): SealedState["status"] {
  if (!supported) return "unsupported";
  if (state.lockedStreams > 0) return "locked";
  if (state.hasKey && state.securedStreams > 0) return "sealed";
  if (state.hasKey) return "sealed";
  return "clear";
}

export function installPageBridge(hooks: PageBridgeHooks): () => void {
  const target = host();
  if (!target) return () => {};

  const support = hooks.support();
  let disposed = false;

  const post = (message: PageMessage) => {
    if (disposed) return;
    try {
      target.postMessage(JSON.stringify(message));
    } catch {
      // A serialisation failure must not break the call.
    }
  };

  let lastSent = "";
  const publish = () => {
    const base = hooks.snapshot();
    const state: SealedState = {
      ...base,
      status: statusFor(base, support.supported),
      tracks: hooks.tracks(),
    };
    const encoded = JSON.stringify(state);
    // The cipher reports stats every second per stream; most ticks change nothing the
    // native UI cares about. Sending only real changes keeps the bridge quiet.
    if (encoded === lastSent) return;
    lastSent = encoded;
    post({ t: "state", state });
  };

  const handle = async (raw: string) => {
    let message: HostMessage;
    try {
      message = JSON.parse(raw) as HostMessage;
    } catch {
      return;
    }
    try {
      switch (message.t) {
        case "key":
          if (message.mode === "passphrase") await hooks.enablePassphrase(message.value);
          else hooks.enableRawKey(message.value);
          publish();
          return;
        case "forget":
          hooks.forgetKey();
          publish();
          return;
        case "verbose":
          hooks.setVerbose(message.value);
          return;
        case "fingerprint": {
          const value = await hooks.fingerprint(message.value, message.mode);
          post({ t: "fingerprint", nonce: message.nonce, value });
          return;
        }
        case "sync":
          lastSent = "";
          publish();
          return;
        case "resume":
          await hooks.onResume?.();
          lastSent = "";
          publish();
          return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      post({
        t: "error",
        message: text,
        ...("nonce" in message ? { nonce: message.nonce } : {}),
      });
    }
  };

  const bridge = { receive: handle };
  (globalThis as { __sealedCall?: typeof bridge }).__sealedCall = bridge;

  post({ t: "ready", version: PROTOCOL_VERSION, supported: support.supported, reason: support.reason });

  const unsubscribe = hooks.subscribe(publish);
  publish();

  // Anything the shell sent before this ran — a key typed while the page was still
  // booting — is waiting here.
  const queued = (globalThis as { __sealedCallQueue?: string[] }).__sealedCallQueue ?? [];
  (globalThis as { __sealedCallQueue?: string[] }).__sealedCallQueue = [];
  for (const raw of queued) void handle(raw);

  return () => {
    disposed = true;
    unsubscribe();
    delete (globalThis as { __sealedCall?: unknown }).__sealedCall;
  };
}

export { PAGE_STATUS_IN_CALL, PROTOCOL_VERSION, trackStateFrom } from "./protocol";
export type {
  CipherTrackState,
  HostMessage,
  KeyMode,
  PageMessage,
  SealedState,
  SealedStatus,
  SealedTrack,
  TrackState,
} from "./protocol";

/**
 * Reports a failure to the React Native shell, if there is one.
 *
 * Without this a failure inside the page is invisible: the shell shows a black WebView
 * and the message only exists in a DOM node nobody is looking at.
 */
export function postPageError(message: string): void {
  const target = host();
  if (!target) return;
  try {
    target.postMessage(JSON.stringify({ t: "error", message }));
  } catch {
    // Nothing useful to do if even the error channel is broken.
  }
}

/** Reports progress to the shell. Invisible WebView contents help nobody. */
export function postPageStatus(text: string): void {
  const target = host();
  if (!target) return;
  try {
    target.postMessage(JSON.stringify({ t: "status", text }));
  } catch {
    // Progress reporting must never break the call.
  }
}

/** Reports what the WebView can see and open. Shown persistently by the shell. */
export function postPageMedia(report: string): void {
  const target = host();
  if (!target) return;
  try {
    target.postMessage(JSON.stringify({ t: "media", report }));
  } catch {
    // Diagnostics must never break the call.
  }
}
