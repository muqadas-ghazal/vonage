import {
  MEDIA_KEY_BYTES,
  createFrameCipher,
  decodeMediaKey,
  deriveKeyFromPassphrase,
  encodeMediaKey,
  frameCipherSupport,
  generateMediaKey,
  mediaKeyFingerprint,
  type CipherState,
  type FrameCipher,
} from "@booth/frame-cipher";

const EMPTY: CipherState = {
  hasKey: false,
  sending: false,
  keyId: null,
  generation: 0,
  lockedStreams: 0,
  securedStreams: 0,
  plaintextStreams: 0,
};

let cipher: FrameCipher | null = null;
let room = "";
let current: CipherState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: CipherState) {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Creates the cipher and patches RTCPeerConnection.
 *
 * Must run *before* the Vonage SDK builds its peer connection, because `install()` works
 * by replacing prototype methods and only sees connections created after it is in place.
 */
export function arm(roomName: string) {
  room = roomName;
  if (cipher) return;
  cipher = createFrameCipher({
    // Calls start unencrypted. Sealing begins only when someone supplies a key.
    key: null,
    headerPolicy: "sfu",
    forwardSecrecy: true,
    onStateChange: publish,
  });
  cipher.install();
}

export function state(): CipherState {
  return current;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function support() {
  return frameCipherSupport();
}

export function streams() {
  return cipher?.getStreams() ?? [];
}

export function trackEncryption(trackId: string) {
  return cipher?.trackState(trackId) ?? "unknown";
}

/** Advances the ratchet when the room's membership changes, so leavers lose access. */
export function rekeyOnMembershipChange() {
  if (cipher?.state().hasKey) cipher.ratchet();
}

/** Accepts base64url (43 chars) or hex (64 chars). */
export function parseKeyInput(value: string): Uint8Array {
  const clean = value.trim().replace(/\s+/g, "");
  if (!clean) throw new Error("Paste a key, or use a passphrase.");

  // Only hex at exactly the right length: a base64url key can be all hex characters too,
  // and guessing wrong would reject a perfectly good key.
  if (new RegExp(`^[0-9a-fA-F]{${MEDIA_KEY_BYTES * 2}}$`).test(clean)) {
    const bytes = new Uint8Array(MEDIA_KEY_BYTES);
    for (let index = 0; index < MEDIA_KEY_BYTES; index += 1) {
      bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error("A key is base64url (A–Z a–z 0–9 - _) or hex.");
  }
  const bytes = decodeMediaKey(clean);
  if (bytes.byteLength !== MEDIA_KEY_BYTES) {
    throw new Error(`A key must be ${MEDIA_KEY_BYTES} bytes, this one is ${bytes.byteLength}.`);
  }
  return bytes;
}

export function generateKeyString(): string {
  return encodeMediaKey(generateMediaKey());
}

/**
 * Stretches the passphrase and starts sealing.
 *
 * The room name is the salt, so the same words in a different room derive a different key.
 */
export async function enableEncryption(passphrase: string): Promise<void> {
  if (!cipher) throw new Error("The call is not connected yet.");
  cipher.setKey(await deriveKeyFromPassphrase(passphrase, room));
  publish(cipher.state());
}

export function enableEncryptionWithKey(value: string): void {
  if (!cipher) throw new Error("The call is not connected yet.");
  cipher.setKey(parseKeyInput(value));
  publish(cipher.state());
}

/**
 * Drops the key: we stop sealing and can no longer read sealed peers.
 *
 * Deliberately the only way to stop encrypting. Holding the key while sending in the clear
 * looks secure on your own screen while your camera goes out unprotected.
 */
export function forgetKey(): void {
  cipher?.setKey(null);
  if (cipher) publish(cipher.state());
}

export async function passphraseFingerprint(passphrase: string): Promise<string> {
  return mediaKeyFingerprint(await deriveKeyFromPassphrase(passphrase, room));
}

export async function keyStringFingerprint(value: string): Promise<string> {
  return mediaKeyFingerprint(parseKeyInput(value));
}

export function setVerbose(value: boolean) {
  cipher?.setVerbose(value);
}
