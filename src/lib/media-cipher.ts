/**
 * Booth's use of the frame cipher. The reusable parts live in @booth/frame-cipher;
 * this file only holds the choices this app makes.
 */
import {
  createFrameCipher,
  ensureMediaKey,
  frameCipherSupport,
  withKeyFragment,
  type FrameCipher,
  type KeyMismatch,
} from "@booth/frame-cipher";

let cipher: FrameCipher | null = null;
let keyMismatch: KeyMismatch | null = null;
const mismatchListeners = new Set<() => void>();

export function ensureSharedKey(): Uint8Array {
  return ensureMediaKey({ storageKey: "booth:media-key" });
}

/** The room link including the key fragment. Without the fragment the other browser cannot decrypt anything. */
export function roomLink(room: string): string {
  return withKeyFragment(`${window.location.origin}/call/${room}`, ensureSharedKey());
}

export function hasKeyMismatch(): boolean {
  return keyMismatch !== null;
}

export function subscribeKeyMismatch(listener: () => void): () => void {
  mismatchListeners.add(listener);
  return () => {
    mismatchListeners.delete(listener);
  };
}

export function mediaCipher(): FrameCipher | null {
  return cipher;
}

export function setCipherVerbose(value: boolean) {
  cipher?.setVerbose(value);
}

/**
 * Rekeys the call. Every participant has to do this for the call to keep working, so it is
 * driven by connection events, which all of them see.
 */
export function rekeyOnMembershipChange() {
  cipher?.ratchet();
}

export function isCipherVerbose(): boolean {
  return cipher?.isVerbose() ?? false;
}

/**
 * Installs the frame cipher before the Vonage SDK is imported.
 * The SDK snapshots peer-connection methods while it loads, so this has to run first.
 */
export function armMediaCipher(): void {
  if (cipher) return;
  if (typeof window === "undefined") return;

  const support = frameCipherSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? "This browser cannot encrypt the call.");
  }

  const flags = new URLSearchParams(window.location.search);
  cipher = createFrameCipher({
    key: ensureSharedKey(),
    // "full" would also encrypt the codec header, but then the receiving WebRTC stack
    // cannot tell a key frame from a delta frame and its recovery after packet loss
    // suffers. The header is authenticated either way; it is simply not secret.
    headerPolicy: "sfu",
    forwardSecrecy: true,
    verbose: flags.get("cipherlog") === "verbose",
    console: flags.get("cipherlog") !== "off",
    onKeyMismatch: (info) => {
      keyMismatch = info;
      for (const listener of mismatchListeners) listener();
    },
  });
  cipher.install();

  if (flags.has("cipherlog")) {
    (window as unknown as Record<string, unknown>).__cipherStreams = () => cipher?.getStreams();
  }
}
