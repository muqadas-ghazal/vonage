// Runs the keys module with no DOM globals at all, which is what React Native looks like.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Strip everything React Native does not have, BEFORE importing the module, so any
// reliance on btoa/atob/Buffer or the DOM shows up as a failure rather than passing here
// and breaking on a phone.
for (const name of ["window", "document", "location", "history", "sessionStorage", "btoa", "atob", "Buffer"]) {
  delete globalThis[name];
}
assert.equal(typeof globalThis.btoa, "undefined");
assert.equal(typeof globalThis.location, "undefined");

const {
  decodeMediaKey, encodeMediaKey, generateMediaKey, mediaKeyFingerprintSync,
  readKeyFromFragment, withKeyFragment, MEDIA_KEY_BYTES,
} = await import("../dist/keys.js");

// Node's Buffer is still reachable through the module system for comparison purposes.
const { Buffer: NodeBuffer } = await import("node:buffer");

test("generates a 32-byte secret", () => {
  assert.equal(generateMediaKey().byteLength, MEDIA_KEY_BYTES);
});

test("base64url round-trips without btoa/atob", () => {
  for (let i = 0; i < 200; i += 1) {
    const key = generateMediaKey();
    const encoded = encodeMediaKey(key);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "must be URL-safe and unpadded");
    assert.deepEqual(decodeMediaKey(encoded), key);
  }
});

test("encoding matches Node's base64url exactly", () => {
  for (let i = 0; i < 50; i += 1) {
    const key = generateMediaKey();
    assert.equal(encodeMediaKey(key), NodeBuffer.from(key).toString("base64url"));
  }
});

test("base64url handles lengths that are not a multiple of three", () => {
  for (const length of [1, 2, 3, 4, 5, 31, 32, 33]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37) & 0xff);
    assert.equal(encodeMediaKey(bytes), NodeBuffer.from(bytes).toString("base64url"), `length ${length}`);
    assert.deepEqual(decodeMediaKey(encodeMediaKey(bytes)), bytes, `length ${length}`);
  }
});

test("the pure SHA-256 fingerprint matches a real SHA-256", () => {
  for (let i = 0; i < 50; i += 1) {
    const key = generateMediaKey();
    const expected = createHash("sha256").update(key).digest("hex").slice(0, 4);
    assert.equal(mediaKeyFingerprintSync(key), expected);
  }
});

test("the same secret fingerprints the same on any platform", () => {
  const key = new Uint8Array(32).fill(7);
  assert.equal(mediaKeyFingerprintSync(key), createHash("sha256").update(key).digest("hex").slice(0, 4));
});

test("link helpers work without a DOM", () => {
  const key = generateMediaKey();
  const link = withKeyFragment("https://example.com/call/room", key);
  assert.ok(link.includes("#k="));
  assert.deepEqual(readKeyFromFragment(link), key);
});

test("a link without a key, or with a malformed one, reads as null", () => {
  assert.equal(readKeyFromFragment("https://example.com/call/room"), null);
  assert.equal(readKeyFromFragment("https://example.com/call/room#k=tooshort"), null);
});

test("withKeyFragment replaces an existing key rather than appending", () => {
  const first = generateMediaKey();
  const second = generateMediaKey();
  const link = withKeyFragment(withKeyFragment("https://x.test/r", first), second);
  assert.deepEqual(readKeyFromFragment(link), second);
  assert.equal(link.split("k=").length - 1, 1);
});
