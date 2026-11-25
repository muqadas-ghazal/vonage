/**
 * The message protocol between the React Native shell and the call page in the WebView.
 *
 * Both sides are ours, but they are separate JavaScript realms with no shared memory, so
 * every value crossing this boundary is JSON. Keys cross it too — in the host-to-page
 * direction only, and they are never logged and never sent back out.
 */

export const PROTOCOL_VERSION = 1;

/**
 * The status the page reports once it is publishing.
 *
 * The shell waits for this before starting the background keep-alive: Android restricts
 * camera access for an app running a foreground service whose type does not include
 * `camera`, and ours declares `microphone` only. Starting the service before the WebView
 * has acquired the camera makes getUserMedia fail with NotReadableError. Starting it
 * after means the camera is already held, and Android 14's rule that a microphone service
 * cannot start from the background is still satisfied, because the call screen is visible.
 */
export const PAGE_STATUS_IN_CALL = "In the call";

/** How a tile's media is travelling right now. Mirrors the web app's per-tile badge. */
export type TrackState = "sealed" | "locked" | "clear" | "unknown";

/**
 * The call's overall encryption state.
 *
 * `unsupported` is a real, expected outcome: an Android System WebView older than 141 has
 * no `RTCRtpScriptTransform`, so sealing is impossible on that device. Saying so is the
 * honest behaviour — the alternative is sending in the clear behind a lock icon.
 */
export type SealedStatus =
  | "connecting"
  | "unsupported"
  | "clear"
  | "locked"
  | "sealed";

export type SealedTrack = {
  trackId: string;
  kind: "audio" | "video";
  state: TrackState;
};

export type SealedState = {
  status: SealedStatus;
  /** We hold a key, so we are sealing what we send and can open what matches. */
  hasKey: boolean;
  sending: boolean;
  /** Short public tag for the key in use. Equal on both sides means the same key. */
  keyId: string | null;
  generation: number;
  /** Remote streams sealed with a key we do not hold — prompt for the passphrase. */
  lockedStreams: number;
  /** Remote streams we are decrypting. */
  securedStreams: number;
  /** Remote streams still in the clear. */
  plaintextStreams: number;
  tracks: SealedTrack[];
};

export const INITIAL_STATE: SealedState = {
  status: "connecting",
  hasKey: false,
  sending: false,
  keyId: null,
  generation: 0,
  lockedStreams: 0,
  securedStreams: 0,
  plaintextStreams: 0,
  tracks: [],
};

/** How the user gave us the secret. */
export type KeyMode = "passphrase" | "raw";

/** React Native -> call page. */
export type HostMessage =
  | { t: "key"; mode: KeyMode; value: string }
  | { t: "forget" }
  | { t: "verbose"; value: boolean }
  | { t: "fingerprint"; mode: KeyMode; value: string; nonce: string }
  /** Ask the page to re-send its current state, e.g. after returning from background. */
  | { t: "sync" }
  /**
   * The app has returned to the foreground.
   *
   * The page can see this itself through `visibilitychange`, but only reliably on iOS —
   * on Android, Chromium derives page visibility from the view's state and may not report
   * it. AppState in the shell is authoritative, so it drives the recovery too.
   */
  | { t: "resume" };

/** Call page -> React Native. */
export type PageMessage =
  | {
      t: "ready";
      version: number;
      supported: boolean;
      /** Why sealing is impossible, when `supported` is false. Safe to show a user. */
      reason?: string;
    }
  | { t: "state"; state: SealedState }
  /** Progress from inside the page, so the shell can show it in native UI. */
  | { t: "status"; text: string }
  /**
   * What the WebView can actually see and open, reported once before publishing.
   *
   * Separate from `status` because status is transient — the next stage overwrites it —
   * and this is the line you need to still be on screen when the call fails.
   */
  | { t: "media"; report: string }
  | { t: "fingerprint"; nonce: string; value: string }
  | { t: "error"; message: string; nonce?: string };

export function parsePageMessage(raw: string): PageMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const t = (value as { t?: unknown }).t;
    if (typeof t !== "string") return null;
    return value as PageMessage;
  } catch {
    // The page shares `onMessage` with nothing else today, but a stray postMessage from
    // an injected script or an extension must not take the call down.
    return null;
  }
}

/** What `FrameCipher.trackState()` returns. Its vocabulary differs from ours. */
export type CipherTrackState = "secured" | "locked" | "plaintext" | "unknown";

/**
 * Translates the cipher's track state into the shell's.
 *
 * The two vocabularies are deliberately different — the cipher describes frames, the UI
 * describes what a person is looking at — so the mapping lives here rather than being
 * cast away at each call site. A cast would quietly emit "secured" to the shell, where
 * nothing matches it and the badge would be wrong with no error anywhere.
 */
export function trackStateFrom(state: CipherTrackState): TrackState {
  switch (state) {
    case "secured":
      return "sealed";
    case "plaintext":
      return "clear";
    case "locked":
      return "locked";
    default:
      return "unknown";
  }
}
