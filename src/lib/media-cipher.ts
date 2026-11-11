/**
 * Booth's use of the frame cipher.
 *
 * The call starts in the clear. Encryption is something a participant turns on mid-call by
 * entering a passphrase; everyone else sees their tile lock until they enter the same one.
 */
import {
  createFrameCipher,
  decodeMediaKey,
  deriveKeyFromPassphrase,
  encodeMediaKey,
  frameCipherSupport,
  generateMediaKey,
  mediaKeyFingerprint,
  MEDIA_KEY_BYTES,
  type CipherState,
  type FrameCipher,
} from "@booth/frame-cipher";

let cipher: FrameCipher | null = null;
let room = "";
let state: CipherState = {
  hasKey: false,
  sending: false,
  keyId: null,
  generation: 0,
  lockedStreams: 0,
  securedStreams: 0,
  plaintextStreams: 0,
};
const listeners = new Set<() => void>();

function publish(next: CipherState) {
  state = next;
  for (const listener of listeners) listener();
}

export function cipherState(): CipherState {
  return state;
}

export function serverCipherState(): CipherState {
  return state;
}

export function subscribeCipherState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mediaCipher(): FrameCipher | null {
  return cipher;
}

export function setCipherVerbose(value: boolean) {
  cipher?.setVerbose(value);
}

export function isCipherVerbose(): boolean {
  return cipher?.isVerbose() ?? false;
}

/**
 * Reads a key the user supplied directly, rather than one derived from a passphrase.
 * Accepts base64url (43 chars, what `generateKeyString` produces) or hex (64 chars).
 */
export function parseKeyInput(value: string): Uint8Array {
  const clean = value.trim().replace(/\s+/g, "");
  if (!clean) throw new Error("Paste a key, or generate one.");

  // Only treat it as hex at exactly the right length: a base64url key can be all hex
  // characters too, and guessing wrong would reject a perfectly good key.
  if (new RegExp(`^[0-9a-fA-F]{${MEDIA_KEY_BYTES * 2}}$`).test(clean)) {
    const bytes = new Uint8Array(MEDIA_KEY_BYTES);
    for (let index = 0; index < MEDIA_KEY_BYTES; index += 1) {
      bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error("A key is base64url (A–Z a–z 0–9 - _) or hex. Use a passphrase instead?");
  }
  const bytes = decodeMediaKey(clean);
  if (bytes.byteLength !== MEDIA_KEY_BYTES) {
    throw new Error(`A key must be ${MEDIA_KEY_BYTES} bytes, this one is ${bytes.byteLength}.`);
  }
  return bytes;
}

/** A fresh random key, as a string to share out of band. */
export function generateKeyString(): string {
  return encodeMediaKey(generateMediaKey());
}

export async function keyStringFingerprint(value: string): Promise<string> {
  return mediaKeyFingerprint(parseKeyInput(value));
}

/** Turns encryption on with a key the user supplied, skipping passphrase stretching. */
export function enableEncryptionWithKey(value: string): void {
  if (!cipher) throw new Error("The call is not connected yet.");
  cipher.setKey(parseKeyInput(value));
  publish(cipher.state());
}

/** Shown so both sides can confirm they typed the same passphrase. */
export async function passphraseFingerprint(passphrase: string): Promise<string> {
  const key = await deriveKeyFromPassphrase(passphrase, room);
  return mediaKeyFingerprint(key);
}

/**
 * Turns encryption on for this browser. The passphrase is stretched with PBKDF2 and salted
 * with the room name, so the same words in a different room produce a different key.
 */
export async function enableEncryption(passphrase: string): Promise<void> {
  if (!cipher) throw new Error("The call is not connected yet.");
  const key = await deriveKeyFromPassphrase(passphrase, room);
  cipher.setKey(key);
  publish(cipher.state());
}

/**
 * Drops the key: we stop sealing and can no longer read encrypted peers.
 *
 * This is deliberately the only way to stop encrypting. Keeping the key while sending in
 * the clear is a state nobody can reason about — your own screen keeps decrypting, so it
 * still looks secure, while your camera goes out unprotected. Holding the key means
 * sealing, and not sealing means leaving.
 */
export function forgetKey(): void {
  cipher?.setKey(null);
  if (cipher) publish(cipher.state());
}

/** Is the stream behind this media track sealed, locked, or in the clear? */
export function trackEncryption(trackId: string) {
  return cipher?.trackState(trackId) ?? "unknown";
}

export function rekeyOnMembershipChange() {
  if (cipher?.state().hasKey) cipher.ratchet();
}

export function roomLink(roomName: string): string {
  return `${window.location.origin}/call/${roomName}`;
}

/**
 * Installs the frame cipher before the Vonage SDK is imported.
 * The SDK snapshots peer-connection methods while it loads, so this has to run first.
 *
 * No key is passed: the transforms attach immediately but pass every frame through
 * untouched. Attaching up front means turning encryption on later needs no renegotiation.
 */
export function armMediaCipher(roomName: string): void {
  if (cipher) return;
  if (typeof window === "undefined") return;

  const support = frameCipherSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? "This browser cannot encrypt the call.");
  }

  room = roomName;
  const flags = new URLSearchParams(window.location.search);
  cipher = createFrameCipher({
    key: null,
    headerPolicy: "sfu",
    forwardSecrecy: true,
    verbose: flags.get("cipherlog") === "verbose",
    console: flags.get("cipherlog") !== "off",
    onStateChange: publish,
  });
  cipher.install();
  publish(cipher.state());

  if (flags.has("cipherlog")) {
    (window as unknown as Record<string, unknown>).__cipherStreams = () => cipher?.getStreams();
  }
}
