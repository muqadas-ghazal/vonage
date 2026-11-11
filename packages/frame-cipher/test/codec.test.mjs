import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Evaluate the exact text that ships to the worker, so tests and shipped code cannot drift.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "src", "worker-source.ts"), "utf8");
const body = source.split("String.raw`")[1].split("`;")[0];

const posted = [];
const api = new Function(
  "self",
  "crypto",
  "performance",
  `${body}
   return { KeySchedule, sealFrame, openFrame, headerLength, nonceFor, TRAILER_BYTES, REPLAY_WINDOW };`,
)({ postMessage: (m) => posted.push(m) }, globalThis.crypto, globalThis.performance);

const { KeySchedule, headerLength, nonceFor, TRAILER_BYTES, REPLAY_WINDOW } = api;

/** The worker takes a session (key + sending flag); tests still speak in schedules. */
const sess = (schedule, sending = true) => ({ schedule, sending, options: {} });
const sealFrame = (schedule, ...rest) => api.sealFrame(sess(schedule), ...rest);

/** Wraps openFrame with a per-stream replay window, the way one transform does. */
function receiver(kind = "video") {
  const states = new Map();
  const open = (schedule, ownSenderId, data, probe) =>
    api.openFrame(sess(schedule), ownSenderId, kind, states, data, probe);
  open.states = states;
  return open;
}
const openFrame = (schedule, ownSenderId, data, probe) =>
  api.openFrame(sess(schedule), ownSenderId, "video", new Map(), data, probe);

const SENDER_A = new Uint8Array([1, 2, 3, 4]);
const SENDER_B = new Uint8Array([9, 9, 9, 9]);
const secret = () => crypto.getRandomValues(new Uint8Array(32));
const frame = (n = 400) => crypto.getRandomValues(new Uint8Array(n));

function schedule(root, options = {}) {
  return new KeySchedule(root.slice(), { forwardSecrecy: false, ...options });
}

/** One sender and one receiver that share a call secret, as two separate endpoints would. */
function pair(rootSecret, options = {}) {
  return { tx: schedule(rootSecret, options), rx: schedule(rootSecret, options) };
}

const CASES = [
  ["video", "key", 10],
  ["video", "delta", 3],
  ["audio", undefined, 1],
];

// ── format ────────────────────────────────────────────────────────────────────

for (const [kind, frameType, header] of CASES) {
  test(`${kind}/${frameType ?? "none"}: round-trips to the original bytes`, async () => {
    const { tx, rx } = pair(secret());
    const open = receiver(kind);
    const plain = frame();
    const sealed = await sealFrame(tx, SENDER_A, false, kind, frameType, plain.buffer.slice(0), null);
    const opened = await open(rx, SENDER_B, sealed, null);
    assert.ok(opened);
    assert.deepEqual(new Uint8Array(opened), plain);
  });

  test(`${kind}/${frameType ?? "none"}: keeps the codec header readable, hides the body`, async () => {
    const tx = schedule(secret());
    const plain = frame();
    const probe = { sample: true };
    const sealed = new Uint8Array(
      await sealFrame(tx, SENDER_A, false, kind, frameType, plain.buffer.slice(0), probe),
    );
    assert.equal(probe.header, header);
    assert.deepEqual(sealed.subarray(0, header), plain.subarray(0, header));
    assert.notDeepEqual(sealed.subarray(header, 400), plain.subarray(header, 400));
  });
}

test("overhead is a constant 35 bytes", async () => {
  const tx = schedule(secret());
  for (const size of [64, 512, 4096]) {
    const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame(size).buffer.slice(0), null);
    assert.equal(sealed.byteLength - size, TRAILER_BYTES + 16, `size ${size}`);
    assert.equal(sealed.byteLength - size, 35);
  }
});

test('headerPolicy "full" encrypts the whole frame, leaving nothing readable', async () => {
  const { tx, rx } = pair(secret());
  const plain = frame();
  const probe = { sample: true };
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, true, "video", "key", plain.buffer.slice(0), probe),
  );
  assert.equal(probe.header, 0);
  assert.notDeepEqual(sealed.subarray(0, 10), plain.subarray(0, 10));
  const opened = await openFrame(rx, SENDER_B, sealed.buffer.slice(0), null);
  assert.deepEqual(new Uint8Array(opened), plain);
});

test("an unsealed frame passes through untouched", async () => {
  const rx = schedule(secret());
  const foreign = frame(200);
  const probe = {};
  const out = await openFrame(rx, SENDER_B, foreign.buffer.slice(0), probe);
  assert.deepEqual(new Uint8Array(out), foreign);
  assert.equal(probe.reason, "passthrough");
});

test("a frame at or below the header length is left alone", async () => {
  const tx = schedule(secret());
  const out = await sealFrame(tx, SENDER_A, false, "video", "delta", new Uint8Array(3).buffer, null);
  assert.equal(out.byteLength, 3);
});

// ── authentication ────────────────────────────────────────────────────────────

test("a flipped ciphertext bit is rejected", async () => {
  const { tx, rx } = pair(secret());
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null),
  );
  sealed[100] ^= 0x01;
  await assert.rejects(() => openFrame(rx, SENDER_B, sealed.buffer.slice(0), null));
});

test("rewriting the clear codec header is rejected — the header is covered by the tag", async () => {
  const { tx, rx } = pair(secret());
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, false, "video", "key", frame().buffer.slice(0), null),
  );
  sealed[2] ^= 0xff; // inside the 10-byte clear keyframe header
  await assert.rejects(() => openFrame(rx, SENDER_B, sealed.buffer.slice(0), null));
});

test("rewriting the declared header length is rejected", async () => {
  const { tx, rx } = pair(secret());
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, false, "video", "key", frame().buffer.slice(0), null),
  );
  sealed[sealed.byteLength - 7] = 3; // headerLen 10 → 3, a valid-looking value
  await assert.rejects(() => openFrame(rx, SENDER_B, sealed.buffer.slice(0), null));
});

test("rewriting the counter is rejected", async () => {
  const { tx, rx } = pair(secret());
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null),
  );
  sealed[sealed.byteLength - 12] ^= 0x01;
  await assert.rejects(() => openFrame(rx, SENDER_B, sealed.buffer.slice(0), null));
});

// ── keys ──────────────────────────────────────────────────────────────────────

test("a frame sealed under a different call secret is dropped, not decoded to noise", async () => {
  const tx = schedule(secret());
  const rx = schedule(secret());
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const probe = {};
  assert.equal(await openFrame(rx, SENDER_B, sealed, probe), null);
  assert.equal(probe.reason, "key-mismatch");
  assert.notEqual(probe.sawKeyId, probe.wantKeyId);
});

test("the call secret is never used as the AES key — senders get distinct keys", async () => {
  const rootSecret = secret();
  const s = schedule(rootSecret);
  const a = await s.sender(0, SENDER_A, "video");
  const b = await s.sender(0, SENDER_B, "video");
  const rawA = await crypto.subtle.exportKey("raw", a.key).catch(() => null);
  assert.equal(rawA, null, "derived keys must be non-extractable");
  assert.notDeepEqual(a.nonceBase, b.nonceBase, "senders must not share a nonce base");
});

test("two senders can use the same counter without colliding", async () => {
  const rootSecret = secret();
  const { tx, rx } = pair(rootSecret);
  const txB = schedule(rootSecret);
  const plain = frame();
  const fromA = await sealFrame(tx, SENDER_A, false, "video", "delta", plain.buffer.slice(0), null);
  const fromB = await sealFrame(txB, SENDER_B, false, "video", "delta", plain.buffer.slice(0), null);
  assert.notDeepEqual(new Uint8Array(fromA), new Uint8Array(fromB), "same plaintext must not produce the same frame");
  assert.deepEqual(new Uint8Array(await openFrame(rx, SENDER_B, fromA, null)), plain);
  assert.deepEqual(new Uint8Array(await openFrame(rx, SENDER_A, fromB, null)), plain);
});

test("nonces never repeat across counters", async () => {
  const base = crypto.getRandomValues(new Uint8Array(12));
  const seen = new Set();
  for (let counter = 0; counter < 5000; counter += 1) {
    seen.add(nonceFor(base, counter).join(","));
  }
  assert.equal(seen.size, 5000);
});

// ── replay ────────────────────────────────────────────────────────────────────

test("a captured frame cannot be replayed into the same stream", async () => {
  const { tx, rx } = pair(secret());
  const open = receiver();
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  assert.ok(await open(rx, SENDER_B, sealed.slice(0), null), "first delivery accepted");
  const probe = {};
  assert.equal(await open(rx, SENDER_B, sealed.slice(0), probe), null);
  assert.equal(probe.reason, "replayed");
});

test("audio and video have separate keys, so their counters cannot collide", async () => {
  const rootSecret = secret();
  const s = schedule(rootSecret);
  const audio = await s.sender(0, SENDER_A, "audio");
  const video = await s.sender(0, SENDER_A, "video");
  assert.notDeepEqual(audio.nonceBase, video.nonceBase);
  // both start their own counter at 0 without ever sharing a nonce
  await sealFrame(s, SENDER_A, false, "audio", undefined, frame(80).buffer.slice(0), null);
  await sealFrame(s, SENDER_A, false, "video", "delta", frame(80).buffer.slice(0), null);
  assert.equal(audio.sendCounter, 0);
  assert.equal(video.sendCounter, 0);
});

test("two transforms receiving the same stream each dedupe independently", async () => {
  const rootSecret = secret();
  const tx = schedule(rootSecret);
  const rx = schedule(rootSecret);
  const first = receiver();
  const second = receiver(); // a second transform during renegotiation
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  assert.ok(await first(rx, SENDER_B, sealed.slice(0), null), "first transform accepts");
  assert.ok(await second(rx, SENDER_B, sealed.slice(0), null), "second transform is not starved by the first");
  const probe = {};
  assert.equal(await second(rx, SENDER_B, sealed.slice(0), probe), null, "but it still rejects a true replay");
  assert.equal(probe.reason, "replayed");
});

test("out-of-order frames inside the window are still accepted", async () => {
  const { tx, rx } = pair(secret());
  const open = receiver();
  const frames = [];
  for (let index = 0; index < 5; index += 1) {
    frames.push(await sealFrame(tx, SENDER_A, false, "video", "delta", frame(120).buffer.slice(0), null));
  }
  for (const index of [4, 0, 3, 1, 2]) {
    assert.ok(await open(rx, SENDER_B, frames[index].slice(0), null), `frame ${index}`);
  }
});

test("a frame older than the replay window is rejected", async () => {
  const { tx, rx } = pair(secret());
  const open = receiver();
  const first = await sealFrame(tx, SENDER_A, false, "video", "delta", frame(80).buffer.slice(0), null);
  let latest = null;
  for (let index = 0; index < REPLAY_WINDOW + 10; index += 1) {
    latest = await sealFrame(tx, SENDER_A, false, "video", "delta", frame(80).buffer.slice(0), null);
  }
  assert.ok(await open(rx, SENDER_B, latest.slice(0), null));
  const probe = {};
  assert.equal(await open(rx, SENDER_B, first.slice(0), probe), null);
  assert.equal(probe.reason, "too-old");
});

test("a forged frame cannot poison the replay window", async () => {
  const { tx, rx } = pair(secret());
  const sealed = new Uint8Array(
    await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null),
  );
  const open = receiver();
  const forged = sealed.slice();
  forged[50] ^= 0xff;
  await assert.rejects(() => open(rx, SENDER_B, forged.buffer.slice(0), null));
  // the genuine frame with the same counter must still be accepted afterwards
  assert.ok(await open(rx, SENDER_B, sealed.buffer.slice(0), null));
});

test("a frame looped back to its own sender is dropped", async () => {
  const tx = schedule(secret());
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const probe = {};
  assert.equal(await openFrame(tx, SENDER_A, sealed, probe), null);
  assert.equal(probe.reason, "own-frame");
});

// ── ratchet and forward secrecy ───────────────────────────────────────────────

test("ratcheting changes the key and the receiver follows", async () => {
  const rootSecret = secret();
  const { tx, rx } = pair(rootSecret);
  const plain = frame();

  const before = await sealFrame(tx, SENDER_A, false, "video", "delta", plain.buffer.slice(0), null);
  assert.deepEqual(new Uint8Array(await openFrame(rx, SENDER_B, before, null)), plain);

  assert.equal(await tx.ratchet(), 1);
  const after = await sealFrame(tx, SENDER_A, false, "video", "delta", plain.buffer.slice(0), null);
  assert.deepEqual(new Uint8Array(await openFrame(rx, SENDER_B, after, null)), plain);
  assert.equal(rx.generations.has(1), true, "receiver derived the new generation on demand");
});

test("generations are one-way: the ratcheted state cannot rebuild an older key", async () => {
  const s = schedule(secret(), { forwardSecrecy: true, generationGrace: 0 });
  await s.ready;
  const gen0 = s.generations.get(0).keyIdHex;
  await s.ratchet();
  await s.ratchet();
  assert.equal(s.root, null, "root secret discarded");
  assert.equal(s.generations.has(0), false, "generation 0 forgotten");
  const reached = await s.generation(0);
  assert.equal(reached, null, "generation 0 is unreachable from the ratcheted state");
  assert.notEqual(s.generations.get(2).keyIdHex, gen0);
});

test("frames from a forgotten generation are dropped", async () => {
  const rootSecret = secret();
  const tx = schedule(rootSecret);
  const rx = schedule(rootSecret, { forwardSecrecy: true, generationGrace: 0 });
  const stale = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  await rx.ratchet();
  await rx.ratchet();
  const probe = {};
  assert.equal(await openFrame(rx, SENDER_B, stale, probe), null);
  assert.equal(probe.reason, "stale-generation");
});

test("the grace window keeps frames in flight during a rekey readable", async () => {
  const rootSecret = secret();
  const tx = schedule(rootSecret);
  const rx = schedule(rootSecret, { forwardSecrecy: true, generationGrace: 2 });
  const inFlight = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  await rx.ratchet(); // receiver rekeys first; the sender's frame is still generation 0
  assert.ok(await openFrame(rx, SENDER_B, inFlight, null), "in-flight frame survives one rekey");
});

test("a peer ratcheting far ahead cannot force unbounded derivation", async () => {
  const rootSecret = secret();
  const tx = schedule(rootSecret);
  const rx = schedule(rootSecret);
  for (let index = 0; index < 40; index += 1) await tx.ratchet();
  const far = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const probe = {};
  assert.equal(await openFrame(rx, SENDER_B, far, probe), null);
  assert.equal(probe.reason, "stale-generation");
});

test("ratcheting never drops the generation we are still sending under", async () => {
  const s = schedule(secret(), { forwardSecrecy: true, generationGrace: 0 });
  await s.ready;
  await s.generation(5); // a peer is far ahead; derive forward to follow it
  assert.ok(await s.sender(s.sendGeneration, SENDER_A, "video"), "our own send key survived");
});

// ── misc ──────────────────────────────────────────────────────────────────────

test("header length follows the codec convention", () => {
  assert.equal(headerLength("audio", undefined, false), 1);
  assert.equal(headerLength("video", "delta", false), 3);
  assert.equal(headerLength("video", "key", false), 10);
  assert.equal(headerLength("video", "key", true), 0);
});

test("wiping a schedule clears its key material", async () => {
  const s = schedule(secret());
  await s.ready;
  await s.sender(0, SENDER_A, "video");
  s.wipe();
  assert.equal(s.generations.size, 0);
  assert.equal(s.root, null);
});

test("ratchetTo is idempotent — a repeated rekey cannot push an endpoint out of step", async () => {
  const rootSecret = secret();
  const a = schedule(rootSecret);
  const b = schedule(rootSecret);
  await a.ratchetTo(3);
  await a.ratchetTo(3); // duplicate delivery
  await a.ratchetTo(2); // late, lower target
  await b.ratchetTo(3);
  assert.equal(a.sendGeneration, 3);
  assert.equal(b.sendGeneration, 3);
  const plain = frame();
  const sealed = await sealFrame(a, SENDER_A, false, "video", "delta", plain.buffer.slice(0), null);
  assert.deepEqual(new Uint8Array(await openFrame(b, SENDER_B, sealed, null)), plain);
});

test("a schedule created late catches up to the target generation", async () => {
  const rootSecret = secret();
  const early = schedule(rootSecret);
  await early.ratchetTo(2);
  const late = schedule(rootSecret);
  await late.ratchetTo(2); // what options.generation does for a worker spun up later
  assert.equal(late.sendGeneration, 2);
  const plain = frame();
  const sealed = await sealFrame(early, SENDER_A, false, "video", "delta", plain.buffer.slice(0), null);
  assert.deepEqual(new Uint8Array(await openFrame(late, SENDER_B, sealed, null)), plain);
});

test("every drop is classified, even when frame sampling is off", async () => {
  const tx = schedule(secret());
  const rx = schedule(secret()); // different secret → key mismatch
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const probe = {}; // no `sample` flag: this is the hot path
  assert.equal(await openFrame(rx, SENDER_B, sealed, probe), null);
  assert.equal(probe.reason, "key-mismatch", "reason must be recorded without sampling");
});

test("concurrent transforms never reuse a nonce — the key cache is race-free", async () => {
  const s = schedule(secret());
  // Two sender transforms of the same kind appearing at once, as renegotiation does.
  const [a, b] = await Promise.all([
    s.sender(0, SENDER_A, "video"),
    s.sender(0, SENDER_A, "video"),
  ]);
  assert.equal(a, b, "both transforms must share one key entry, or they share a counter space");

  // Seal concurrently and prove every counter — and so every nonce — is distinct.
  const sealed = await Promise.all(
    Array.from({ length: 50 }, () =>
      sealFrame(s, SENDER_A, false, "video", "delta", frame(80).buffer.slice(0), null),
    ),
  );
  const counters = sealed.map((buffer) => {
    const bytes = new Uint8Array(buffer);
    const at = bytes.byteLength - TRAILER_BYTES + 4;
    let value = 0;
    for (let i = 0; i < 6; i += 1) value = value * 256 + bytes[at + i];
    return value;
  });
  assert.equal(new Set(counters).size, 50, "counters must be unique across concurrent seals");
});

test("concurrent generation derivation yields one shared generation", async () => {
  const s = schedule(secret());
  const [x, y] = await Promise.all([s.generation(3), s.generation(3)]);
  assert.equal(x, y);
  assert.equal(x.index, 3);
});

test("concurrent requests for different generations derive each one exactly once", async () => {
  const s = schedule(secret());
  // A sender ratcheting while a peer's frames arrive asking for an intermediate generation.
  const [g1, g2, g1again] = await Promise.all([s.generation(1), s.generation(2), s.generation(1)]);
  assert.equal(g1, g1again, "generation 1 must be a single object");
  assert.equal(g1, s.generations.get(1), "and the one that got cached");
  assert.equal(g2.index, 2);

  // Two senders resolving through those generations must share one counter space.
  const [a, b] = await Promise.all([s.sender(1, SENDER_A, "video"), s.sender(1, SENDER_A, "video")]);
  assert.equal(a, b);
});

/* ── the on-demand flow: clear call → one side encrypts → the other unlocks ───────── */

const noKey = { schedule: null, sending: false, options: {} };

test("with no key, outgoing frames go out untouched", async () => {
  const plain = frame();
  const probe = {};
  const out = await api.sealFrame(noKey, SENDER_A, false, "video", "delta", plain.buffer.slice(0), probe);
  assert.deepEqual(new Uint8Array(out), plain, "frame must be unchanged");
  assert.equal(probe.reason, "plaintext");
});

test("with a key but sending off, outgoing frames still go out untouched", async () => {
  const s = schedule(secret());
  await s.ready;
  const plain = frame();
  const out = await api.sealFrame({ schedule: s, sending: false, options: {} },
    SENDER_A, false, "video", "delta", plain.buffer.slice(0), {});
  assert.deepEqual(new Uint8Array(out), plain);
});

test("a receiver with no key passes plaintext straight through", async () => {
  const plain = frame();
  const probe = {};
  const out = await api.openFrame(noKey, SENDER_B, "video", new Map(), plain.buffer.slice(0), probe);
  assert.deepEqual(new Uint8Array(out), plain);
  assert.equal(probe.reason, "passthrough");
});

test("a receiver with no key DROPS sealed frames rather than passing ciphertext on", async () => {
  const tx = schedule(secret());
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const probe = {};
  const out = await api.openFrame(noKey, SENDER_B, "video", new Map(), sealed, probe);
  assert.equal(out, null, "ciphertext must never reach the decoder");
  assert.equal(probe.reason, "locked");
});

test("the whole flow: clear, then sealed-and-locked, then unlocked with the same secret", async () => {
  const rootSecret = secret();
  const txSchedule = schedule(rootSecret);
  const sender = { schedule: txSchedule, sending: false, options: {} };
  const receiver = { schedule: null, sending: false, options: {} };
  const states = new Map();
  const plain = frame();

  // 1. nobody has turned encryption on: video flows in the clear
  let out = await api.sealFrame(sender, SENDER_A, false, "video", "delta", plain.buffer.slice(0), {});
  assert.deepEqual(new Uint8Array(await api.openFrame(receiver, SENDER_B, "video", states, out, {})), plain);

  // 2. the sender turns it on; the receiver has no key yet and sees nothing
  sender.sending = true;
  const sealed = await api.sealFrame(sender, SENDER_A, false, "video", "delta", plain.buffer.slice(0), {});
  const lockedProbe = {};
  assert.equal(await api.openFrame(receiver, SENDER_B, "video", states, sealed.slice(0), lockedProbe), null);
  assert.equal(lockedProbe.reason, "locked");

  // 3. the receiver enters the same secret and the picture comes back
  receiver.schedule = schedule(rootSecret);
  const opened = await api.openFrame(receiver, SENDER_B, "video", states, sealed.slice(0), {});
  assert.deepEqual(new Uint8Array(opened), plain, "the same frame now decrypts");
});

test("a receiver that enters the WRONG secret is told so, not shown noise", async () => {
  const tx = schedule(secret());
  const sealed = await sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer.slice(0), null);
  const receiver = { schedule: schedule(secret()), sending: false, options: {} };
  const probe = {};
  assert.equal(await api.openFrame(receiver, SENDER_B, "video", new Map(), sealed, probe), null);
  assert.equal(probe.reason, "key-mismatch");
});

test("turning encryption back off returns the stream to plaintext", async () => {
  const rootSecret = secret();
  const sender = { schedule: schedule(rootSecret), sending: true, options: {} };
  const receiver = { schedule: schedule(rootSecret), sending: true, options: {} };
  const states = new Map();
  const plain = frame();

  const sealed = await api.sealFrame(sender, SENDER_A, false, "video", "delta", plain.buffer.slice(0), {});
  assert.notDeepEqual(new Uint8Array(sealed).subarray(3, 50), plain.subarray(3, 50));

  sender.sending = false;
  const clear = await api.sealFrame(sender, SENDER_A, false, "video", "delta", plain.buffer.slice(0), {});
  assert.deepEqual(new Uint8Array(clear), plain);
  // a receiver that still holds a key passes plaintext through unharmed
  assert.deepEqual(new Uint8Array(await api.openFrame(receiver, SENDER_B, "video", states, clear, {})), plain);
});

test("changing the key does not leave the replay window rejecting the new frames", async () => {
  const states = new Map(); // one receive transform, surviving the key change
  const tx = { schedule: schedule(secret()), sending: true, options: {} };
  const rx = { schedule: null, sending: false, options: {} };
  rx.schedule = schedule(secret());

  // Give both sides the same first key and run enough frames to advance the window.
  const first = secret();
  tx.schedule = schedule(first);
  rx.schedule = schedule(first);
  for (let index = 0; index < 30; index += 1) {
    const sealed = await api.sealFrame(tx, SENDER_A, false, "video", "delta", frame(120).buffer, null);
    assert.ok(await api.openFrame(rx, SENDER_B, "video", states, sealed, {}), `frame ${index}`);
  }

  // Now both change key, exactly as setKey() does. Counters restart at zero.
  const second = secret();
  tx.schedule = schedule(second);
  rx.schedule = schedule(second);

  for (let index = 0; index < 10; index += 1) {
    const sealed = await api.sealFrame(tx, SENDER_A, false, "video", "delta", frame(120).buffer, null);
    const probe = {};
    const out = await api.openFrame(rx, SENDER_B, "video", states, sealed, probe);
    assert.ok(out, `frame ${index} after the key change was dropped: ${probe.reason}`);
  }
});

test("the replay window still works within one key", async () => {
  const rootSecret = secret();
  const tx = { schedule: schedule(rootSecret), sending: true, options: {} };
  const rx = { schedule: schedule(rootSecret), sending: true, options: {} };
  const states = new Map();
  const sealed = await api.sealFrame(tx, SENDER_A, false, "video", "delta", frame().buffer, null);
  assert.ok(await api.openFrame(rx, SENDER_B, "video", states, sealed.slice(0), {}));
  const probe = {};
  assert.equal(await api.openFrame(rx, SENDER_B, "video", states, sealed.slice(0), probe), null);
  assert.equal(probe.reason, "replayed");
});
