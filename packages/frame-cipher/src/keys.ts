/**
 * Key material helpers.
 *
 * This module is deliberately free of DOM and WebRTC dependencies so it runs anywhere —
 * browser, Node, React Native. On React Native the frame cipher itself does not work
 * (see the README), but these helpers still do, and they are the right way to generate
 * and share the secret you hand to Vonage's own `encryptionSecret`.
 *
 * The only platform requirement is a CSPRNG. React Native has none built in: install
 * `react-native-get-random-values` and import it once at the top of your entry file.
 */

const DEFAULT_STORAGE_KEY = "frame-cipher:key";
const DEFAULT_FRAGMENT_PARAM = "k";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const MEDIA_KEY_BYTES = 32;

function randomBytes(length: number): Uint8Array {
  const source = globalThis.crypto;
  if (!source?.getRandomValues) {
    throw new Error(
      "frame-cipher: no secure random source. On React Native, install " +
        "react-native-get-random-values and import it once before this module.",
    );
  }
  return source.getRandomValues(new Uint8Array(length));
}

export function generateMediaKey(): Uint8Array {
  return randomBytes(MEDIA_KEY_BYTES);
}

/** base64url, implemented directly so it does not depend on btoa/atob or Buffer. */
export function encodeMediaKey(key: Uint8Array): string {
  let out = "";
  for (let index = 0; index < key.length; index += 3) {
    const a = key[index];
    const b = key[index + 1];
    const c = key[index + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64URL[c & 63];
  }
  return out;
}

export function decodeMediaKey(value: string): Uint8Array {
  const clean = value.replaceAll("-", "+").replaceAll("_", "/").replace(/[^A-Za-z0-9+/]/g, "");
  const lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let accumulator = 0;
  let at = 0;
  for (const character of clean) {
    const index = lookup.indexOf(character);
    if (index < 0) continue;
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (accumulator >> bits) & 0xff;
      at += 1;
    }
  }
  return out.subarray(0, at);
}

/* ── SHA-256, pure, so a fingerprint means the same thing on every platform ───────── */

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(input: Uint8Array): Uint8Array {
  const h = Int32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const length = input.length;
  const padded = new Uint8Array((((length + 9) >> 6) + 1) << 6);
  padded.set(input);
  padded[length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, length << 3, false);

  const w = new Int32Array(64);
  const view = new DataView(padded.buffer);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setInt32(i * 4, h[i], false);
  return out;
}

/**
 * Short public tag for a secret. Print it on every participant: the same tag means the
 * same secret, and it reveals nothing useful. Works identically on web and React Native.
 */
export async function mediaKeyFingerprint(key: Uint8Array): Promise<string> {
  return [...sha256(key).subarray(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Synchronous form, for platforms and call sites where awaiting is awkward. */
export function mediaKeyFingerprintSync(key: Uint8Array): string {
  return [...sha256(key).subarray(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ── URL helpers. Browser-shaped, but safe to import anywhere. ────────────────────── */

export function readKeyFromFragment(
  url: string = typeof location === "undefined" ? "" : location.href,
  param = DEFAULT_FRAGMENT_PARAM,
): Uint8Array | null {
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const raw = new URLSearchParams(hash).get(param);
  if (!raw) return null;
  try {
    const key = decodeMediaKey(raw);
    return key.byteLength === MEDIA_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** Returns `url` with the secret attached as a fragment, replacing any already there. */
export function withKeyFragment(
  url: string,
  key: Uint8Array,
  param = DEFAULT_FRAGMENT_PARAM,
): string {
  const [base, hash = ""] = url.split("#");
  const params = new URLSearchParams(hash);
  params.set(param, encodeMediaKey(key));
  return `${base}#${params.toString()}`;
}

export type EnsureKeyOptions = {
  /** Where to remember the secret across reloads of this tab. Pass null to keep it in memory only. */
  storage?: Storage | null;
  storageKey?: string;
  fragmentParam?: string;
  /** Write the secret back into the address bar so the link is shareable. Default true. */
  updateUrl?: boolean;
};

/**
 * The usual browser flow: take the secret from the link if there is one, otherwise reuse
 * what this tab had, otherwise mint one — then make sure the address bar carries it.
 *
 * Browser only. On React Native generate the secret with `generateMediaKey()` and move it
 * yourself; there is no address bar to put it in.
 */
export function ensureMediaKey(options: EnsureKeyOptions = {}): Uint8Array {
  const {
    storage = typeof sessionStorage === "undefined" ? null : sessionStorage,
    storageKey = DEFAULT_STORAGE_KEY,
    fragmentParam = DEFAULT_FRAGMENT_PARAM,
    updateUrl = true,
  } = options;

  const fromLink = readKeyFromFragment(undefined, fragmentParam);
  if (fromLink) {
    storage?.setItem(storageKey, encodeMediaKey(fromLink));
    return fromLink;
  }

  const saved = storage?.getItem(storageKey);
  let key: Uint8Array | null = null;
  if (saved) {
    try {
      const decoded = decodeMediaKey(saved);
      if (decoded.byteLength === MEDIA_KEY_BYTES) key = decoded;
    } catch {
      key = null;
    }
  }
  if (!key) key = generateMediaKey();

  storage?.setItem(storageKey, encodeMediaKey(key));
  if (updateUrl && typeof location !== "undefined" && typeof history !== "undefined") {
    history.replaceState(null, "", withKeyFragment(location.href, key, fragmentParam));
  }
  return key;
}
