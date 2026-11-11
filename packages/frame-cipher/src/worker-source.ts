/**
 * The frame transform, as source text.
 *
 * It is a string because it has to run inside a Worker, and shipping it inline means
 * consumers never copy a file into their public directory or configure a bundler.
 * This is the only copy of the crypto; `test/codec.test.mjs` evaluates this same text,
 * so the tested code and the shipped code cannot drift apart.
 *
 * ── Key schedule (HKDF-SHA256) ────────────────────────────────────────────────
 *
 *   root           = the 32-byte call secret
 *   generation[0]  = HKDF(root,           info "fc/v2/gen0")
 *   generation[n+1]= HKDF(generation[n],  info "fc/v2/ratchet")      ← one-way
 *   (key, nonceBase) = HKDF(generation[g], salt senderId, info "fc/v2/sender")
 *   keyId          = HKDF(generation[g],  info "fc/v2/keyid", 2 bytes)
 *
 * The call secret is never used as an AES key. Each sender gets its own key inside each
 * generation, so a nonce can only ever repeat if one sender reuses a counter under one
 * generation — which the monotonic counter makes impossible.
 *
 * ── Nonce ─────────────────────────────────────────────────────────────────────
 *
 *   iv = nonceBase XOR (0⁶ ‖ counter)      counter is 48-bit, per sender, per generation
 *
 * Derived rather than transmitted, which is both safer than a random nonce and 12 bytes
 * cheaper on the wire.
 *
 * ── Frame layout ──────────────────────────────────────────────────────────────
 *
 *   [ clear header ][ ciphertext ‖ 16B GCM tag ][ senderId ‖ counter ‖ gen ‖ flags ‖ headerLen ‖ keyId ‖ magic ]
 *     0/1/3/10 B                                     4 B        6 B      1 B    1 B       1 B       2 B    4 B
 *
 * Everything outside the ciphertext is passed to AES-GCM as additionalData, so the clear
 * codec header and every parsing field are covered by the authentication tag. Rewriting a
 * header byte, a counter, or the declared header length invalidates the frame.
 */
export const WORKER_SOURCE = String.raw`
const MAGIC = [0xb0, 0x07, 0x11, 0x20];
const SENDER_BYTES = 4;
const COUNTER_BYTES = 6;
const KEY_ID_BYTES = 2;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const TRAILER_BYTES = SENDER_BYTES + COUNTER_BYTES + 1 + 1 + 1 + KEY_ID_BYTES + MAGIC.length;
const FLAG_FULL_FRAME = 0x01;
const REPLAY_WINDOW = 1024;
const MAX_LOOKAHEAD = 16;
const MAX_COUNTER = 2 ** (COUNTER_BYTES * 8) - 1;

const textEncoder = new TextEncoder();
const schedules = new Map();
const pendingRatchet = new Map();

let verbose = false;
let sampleFrames = 3;
let mismatchReported = false;

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "cipher-verbose") verbose = Boolean(data.value);
  if (data.type === "cipher-sample") sampleFrames = Number(data.value) || 0;
  if (data.type === "cipher-ratchet") {
    const target = Number(data.target) || 0;
    const schedule = schedules.get(data.scheduleId);
    if (schedule) {
      schedule.ratchetTo(target).then((g) => post({ type: "cipher-ratcheted", generation: g }));
    } else {
      pendingRatchet.set(data.scheduleId, target);
    }
  }
  if (data.type === "cipher-shutdown") {
    const schedule = schedules.get(data.scheduleId);
    if (schedule) schedule.wipe();
    schedules.delete(data.scheduleId);
  }
};

function post(message) {
  self.postMessage(message);
}

function hex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function wipe(bytes) {
  if (bytes) bytes.fill(0);
}

async function hkdf(ikm, info, length, salt) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt || new Uint8Array(0), info: textEncoder.encode(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Holds the ratchet. Generations only move forward: generation[n] cannot produce
 * generation[n-1], so forgetting an old generation makes its frames unreadable for good.
 */
class KeySchedule {
  constructor(root, options) {
    this.root = root;
    this.forwardSecrecy = options.forwardSecrecy !== false;
    this.grace = Number.isFinite(options.generationGrace) ? options.generationGrace : 2;
    this.sendGeneration = 0;
    this.generations = new Map();
    this.deriving = new Map();
    this.ready = this.init();
  }

  async init() {
    const zero = await hkdf(this.root, "fc/v2/gen0", 32);
    this.generations.set(0, await this.materialise(0, zero));
    if (this.forwardSecrecy) {
      // Once the root is gone, nobody holding only this worker's state can rebuild
      // generation 0 — the ratchet becomes genuinely one-way.
      wipe(this.root);
      this.root = null;
    }
  }

  async materialise(index, secret) {
    const keyIdBytes = await hkdf(secret, "fc/v2/keyid", KEY_ID_BYTES);
    return { index, secret, keyId: keyIdBytes, keyIdHex: hex(keyIdBytes), senders: new Map() };
  }

  /** Derives forward to the requested index, within the lookahead bound. Null if unreachable. */
  /**
   * Derives forward to the requested index, within the lookahead bound. Null if unreachable.
   *
   * Every index goes through the in-flight cache and advances exactly one step from its
   * predecessor, so concurrent requests for different generations still derive each one
   * once. Deriving an intermediate generation twice would hand two callers two different
   * objects, each with its own sender cache and its own counter starting at zero.
   */
  async generation(index) {
    await this.ready;
    const existing = this.generations.get(index);
    if (existing) return existing;
    const inFlight = this.deriving.get(index);
    if (inFlight) return inFlight;

    if (index < 0) return null;
    let highest = -1;
    for (const key of this.generations.keys()) if (key > highest) highest = key;
    if (highest < 0) return null;
    if (index <= highest) return null; // inside the window but already forgotten
    if (index - highest > MAX_LOOKAHEAD) return null; // refuse unbounded derivation

    const task = this.deriveStep(index);
    this.deriving.set(index, task);
    try {
      return await task;
    } finally {
      this.deriving.delete(index);
    }
  }

  async deriveStep(index) {
    const previous = await this.generation(index - 1);
    if (!previous) return null;
    const secret = await hkdf(previous.secret, "fc/v2/ratchet", 32);
    const made = await this.materialise(index, secret);
    this.generations.set(index, made);
    this.forget(index);
    return made;
  }

  /** Drops generations older than the grace window. This is what delivers forward secrecy. */
  forget(newest) {
    if (!this.forwardSecrecy) return;
    for (const [index, generation] of this.generations) {
      if (index >= newest - this.grace) continue;
      if (index === this.sendGeneration) continue; // a peer may be ahead of us; keep sending
      for (const pending of generation.senders.values()) {
        Promise.resolve(pending).then((entry) => wipe(entry && entry.nonceBase), () => {});
      }
      wipe(generation.secret);
      this.generations.delete(index);
    }
  }

  async ratchet() {
    return this.ratchetTo(this.sendGeneration + 1);
  }

  /** Idempotent: advancing to a target already reached is a no-op, so a repeated or
   *  late-delivered rekey cannot push this endpoint out of step with its peers. */
  async ratchetTo(target) {
    await this.ready;
    while (this.sendGeneration < target) {
      const next = this.sendGeneration + 1;
      if (!(await this.generation(next))) break;
      this.sendGeneration = next;
    }
    return this.sendGeneration;
  }

  async sender(generationIndex, senderId, kind) {
    const generation = await this.generation(generationIndex);
    if (!generation) return null;
    const id = kind + ":" + hex(senderId);
    let pending = generation.senders.get(id);
    if (!pending) {
      pending = this.deriveSender(generation, senderId, kind);
      generation.senders.set(id, pending); // registered before the first await
    }
    return pending;
  }

  async deriveSender(generation, senderId, kind) {
    const material = await hkdf(generation.secret, "fc/v2/sender/" + kind, 32 + NONCE_BYTES, senderId);
    const entry = {
      key: await crypto.subtle.importKey("raw", material.slice(0, 32), { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]),
      nonceBase: material.slice(32),
      keyId: generation.keyId,
      keyIdHex: generation.keyIdHex,
      // Shared by every sender transform of this kind, so two transforms that briefly
      // coexist during renegotiation can never hand the same nonce to the same key.
      sendCounter: -1,
    };
    wipe(material);
    return entry;
  }

  wipe() {
    wipe(this.root);
    this.root = null;
    for (const generation of this.generations.values()) {
      for (const pending of generation.senders.values()) {
        Promise.resolve(pending).then((entry) => wipe(entry && entry.nonceBase), () => {});
      }
      wipe(generation.secret);
    }
    this.generations.clear();
    this.deriving.clear();
  }
}

/** Video keeps the codec payload header readable so an SFU can still classify the frame. */
function headerLength(kind, frameType, fullFrame) {
  if (fullFrame) return 0;
  if (kind === "audio") return 1;
  return frameType === "delta" ? 3 : 10;
}

function validHeaderLength(value) {
  return value === 0 || value === 1 || value === 3 || value === 10;
}

function nonceFor(nonceBase, counter) {
  const iv = nonceBase.slice();
  let rest = counter;
  for (let index = NONCE_BYTES - 1; index >= NONCE_BYTES - COUNTER_BYTES; index -= 1) {
    iv[index] ^= rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return iv;
}

function writeTrailer(target, at, senderId, counter, generation, flags, headerLen, keyId) {
  target.set(senderId, at);
  let cursor = at + SENDER_BYTES;
  let rest = counter;
  for (let index = COUNTER_BYTES - 1; index >= 0; index -= 1) {
    target[cursor + index] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  cursor += COUNTER_BYTES;
  target[cursor] = generation;
  target[cursor + 1] = flags;
  target[cursor + 2] = headerLen;
  target.set(keyId, cursor + 3);
  target.set(MAGIC, cursor + 3 + KEY_ID_BYTES);
}

function readCounter(bytes, at) {
  let value = 0;
  for (let index = 0; index < COUNTER_BYTES; index += 1) value = value * 256 + bytes[at + index];
  return value;
}

/** Everything in the clear is authenticated: the codec header and every parsing field. */
function aadFor(source, headerLen, trailer) {
  const aad = new Uint8Array(headerLen + trailer.byteLength);
  aad.set(source.subarray(0, headerLen), 0);
  aad.set(trailer, headerLen);
  return aad;
}

function hasMagic(bytes) {
  if (bytes.byteLength < TRAILER_BYTES + TAG_BYTES) return false;
  const start = bytes.byteLength - MAGIC.length;
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[start + index] !== MAGIC[index]) return false;
  }
  return true;
}

/** Standard sliding-window anti-replay. Only consulted for frames that already authenticated. */
function replayCheck(state, counter) {
  if (counter > state.highest) return "ok";
  const back = state.highest - counter;
  if (back >= REPLAY_WINDOW) return "too-old";
  return (state.bitmap >> BigInt(back)) & 1n ? "replayed" : "ok";
}

function replayRecord(state, counter) {
  if (counter > state.highest) {
    const shift = BigInt(counter - state.highest);
    state.bitmap = shift >= BigInt(REPLAY_WINDOW) ? 1n : ((state.bitmap << shift) | 1n);
    state.bitmap &= (1n << BigInt(REPLAY_WINDOW)) - 1n;
    state.highest = counter;
  } else {
    state.bitmap |= 1n << BigInt(state.highest - counter);
  }
}

async function sealFrame(schedule, senderId, fullFrame, kind, frameType, data, probe) {
  probe = probe || {};
  const generation = schedule.sendGeneration;
  const entry = await schedule.sender(generation, senderId, kind);
  if (!entry) {
    probe.reason = "no-key";
    return null;
  }

  const headerLen = headerLength(kind, frameType, fullFrame);
  const source = new Uint8Array(data);
  if (source.byteLength <= headerLen) {
    probe.reason = "passthrough";
    return source.buffer;
  }

  const counter = entry.sendCounter + 1;
  if (counter > MAX_COUNTER) {
    probe.reason = "counter-exhausted";
    return null;
  }
  entry.sendCounter = counter;

  const flags = fullFrame ? FLAG_FULL_FRAME : 0;
  const trailer = new Uint8Array(TRAILER_BYTES);
  writeTrailer(trailer, 0, senderId, counter, generation, flags, headerLen, entry.keyId);

  const body = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonceFor(entry.nonceBase, counter),
      tagLength: TAG_BYTES * 8,
      additionalData: aadFor(source, headerLen, trailer),
    },
    entry.key,
    source.slice(headerLen),
  );

  const cipher = new Uint8Array(body);
  const out = new Uint8Array(headerLen + cipher.byteLength + TRAILER_BYTES);
  out.set(source.subarray(0, headerLen), 0);
  out.set(cipher, headerLen);
  out.set(trailer, headerLen + cipher.byteLength);

  if (probe.sample) {
    probe.header = headerLen;
    probe.generation = generation;
    probe.counter = counter;
    probe.clearHex = hex(source.subarray(0, headerLen));
    probe.beforeHex = hex(source.subarray(headerLen, headerLen + 8));
    probe.afterHex = hex(cipher.subarray(0, 8));
  }
  return out.buffer;
}

async function openFrame(schedule, ownSenderId, kind, replayStates, data, probe) {
  probe = probe || {};
  const source = new Uint8Array(data);
  if (!hasMagic(source)) {
    probe.reason = "passthrough";
    return source.buffer;
  }

  const trailerAt = source.byteLength - TRAILER_BYTES;
  const trailer = source.subarray(trailerAt);
  const senderId = trailer.subarray(0, SENDER_BYTES);
  const counter = readCounter(trailer, SENDER_BYTES);
  const generation = trailer[SENDER_BYTES + COUNTER_BYTES];
  const flags = trailer[SENDER_BYTES + COUNTER_BYTES + 1];
  const headerLen = trailer[SENDER_BYTES + COUNTER_BYTES + 2];
  const keyIdAt = SENDER_BYTES + COUNTER_BYTES + 3;

  if (!validHeaderLength(headerLen) || trailerAt - headerLen < TAG_BYTES) {
    probe.reason = "bad-header";
    return null;
  }
  let mine = true;
  for (let index = 0; index < SENDER_BYTES; index += 1) {
    if (senderId[index] !== ownSenderId[index]) { mine = false; break; }
  }
  if (mine) {
    // Our own frame looped back. Decrypting it would blow a hole in the replay window.
    probe.reason = "own-frame";
    return null;
  }

  const entry = await schedule.sender(generation, senderId, kind);
  if (!entry) {
    probe.reason = "stale-generation";
    probe.generation = generation;
    return null;
  }

  for (let index = 0; index < KEY_ID_BYTES; index += 1) {
    if (trailer[keyIdAt + index] !== entry.keyId[index]) {
      probe.reason = "key-mismatch";
      probe.sawKeyId = hex(trailer.subarray(keyIdAt, keyIdAt + KEY_ID_BYTES));
      probe.wantKeyId = entry.keyIdHex;
      return null;
    }
  }

  const replayKey = generation + ":" + hex(senderId);
  let replay = replayStates.get(replayKey);
  if (!replay) {
    replay = { highest: -1, bitmap: 0n };
    replayStates.set(replayKey, replay);
  }

  const verdict = replayCheck(replay, counter);
  if (verdict !== "ok") {
    probe.reason = verdict === "replayed" ? "replayed" : "too-old";
    probe.counter = counter;
    return null;
  }

  const body = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonceFor(entry.nonceBase, counter),
      tagLength: TAG_BYTES * 8,
      additionalData: aadFor(source, headerLen, trailer),
    },
    entry.key,
    source.slice(headerLen, trailerAt),
  );

  // Only after the tag verified, so forged frames cannot poison the window.
  replayRecord(replay, counter);

  const plain = new Uint8Array(body);
  const out = new Uint8Array(headerLen + plain.byteLength);
  out.set(source.subarray(0, headerLen), 0);
  out.set(plain, headerLen);

  if (probe.sample) {
    probe.header = headerLen;
    probe.generation = generation;
    probe.counter = counter;
    probe.fullFrame = Boolean(flags & FLAG_FULL_FRAME);
    probe.clearHex = hex(source.subarray(0, headerLen));
    probe.beforeHex = hex(source.subarray(headerLen, headerLen + 8));
    probe.afterHex = hex(plain.subarray(0, 8));
  }
  return out.buffer;
}

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const options = transformer.options || {};
  const op = options.op;
  const kind = options.kind;
  const scheduleId = options.scheduleId;
  const senderId = new Uint8Array(options.senderId);
  const fullFrame = Boolean(options.fullFrame);
  const id = options.streamId;
  if (typeof options.sampleFrames === "number") sampleFrames = options.sampleFrames;
  if (typeof options.verbose === "boolean") verbose = options.verbose;

  let schedule = schedules.get(scheduleId);
  if (!schedule) {
    schedule = new KeySchedule(new Uint8Array(options.rootSecret), options);
    schedules.set(scheduleId, schedule);
    const target = Math.max(Number(options.generation) || 0, pendingRatchet.get(scheduleId) || 0);
    pendingRatchet.delete(scheduleId);
    if (target > 0) schedule.ratchetTo(target);
  }

  const reader = transformer.readable.getReader();
  const writer = transformer.writable.getWriter();
  const replayStates = new Map();

  const stats = {
    frames: 0, inBytes: 0, outBytes: 0, keyFrames: 0,
    passthrough: 0, dropped: 0, mismatched: 0, replayed: 0,
    staleGeneration: 0, failed: 0, cryptoMs: 0, generation: 0,
    reasons: {},
  };
  let lastFlush = 0;

  const flush = (force) => {
    const now = performance.now();
    if (!force && now - lastFlush < 1000) return;
    lastFlush = now;
    stats.generation = schedule.sendGeneration;
    post({ type: "cipher-stats", id, op, kind, ...stats });
  };

  const pump = async () => {
    await schedule.ready;
    const generation = await schedule.generation(schedule.sendGeneration);
    post({
      type: "cipher-open", id, op, kind,
      algorithm: "AES-GCM",
      keyId: generation ? generation.keyIdHex : "????",
      senderId: hex(senderId),
      fullFrame,
    });
    lastFlush = performance.now();

    for (;;) {
      const next = await reader.read();
      if (next.done) {
        flush(true);
        post({ type: "cipher-close", id, op, kind });
        await writer.close();
        return;
      }

      const frame = next.value;
      const inBytes = frame.data.byteLength;
      const probe = { sample: stats.frames < sampleFrames || verbose };
      const startedAt = performance.now();

      try {
        const data = op === "encrypt"
          ? await sealFrame(schedule, senderId, fullFrame, kind, frame.type, frame.data, probe)
          : await openFrame(schedule, senderId, kind, replayStates, frame.data, probe);

        stats.cryptoMs += performance.now() - startedAt;
        stats.frames += 1;
        stats.inBytes += inBytes;
        if (frame.type === "key") stats.keyFrames += 1;

        if (!data) {
          stats.dropped += 1;
          const reason = probe.reason || "unknown";
          stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
          if (reason === "replayed" || reason === "too-old") stats.replayed += 1;
          if (reason === "stale-generation") stats.staleGeneration += 1;
          if (reason === "key-mismatch") {
            stats.mismatched += 1;
            if (!mismatchReported) {
              mismatchReported = true;
              post({ type: "cipher-key-mismatch", id, kind, saw: probe.sawKeyId, want: probe.wantKeyId });
            }
          }
          flush(false);
          continue;
        }

        stats.outBytes += data.byteLength;
        if (probe.reason === "passthrough") stats.passthrough += 1;

        if (probe.sample && !probe.reason) {
          post({
            type: "cipher-frame", id, op, kind,
            seq: stats.frames,
            frameType: frame.type,
            inBytes,
            outBytes: data.byteLength,
            headerBytes: probe.header,
            generation: probe.generation,
            counter: probe.counter,
            clearHex: probe.clearHex,
            beforeHex: probe.beforeHex,
            afterHex: probe.afterHex,
            ms: Number((performance.now() - startedAt).toFixed(3)),
          });
        }

        frame.data = data;
      } catch (error) {
        stats.failed += 1;
        // A frame that fails authentication is dropped, never handed to the decoder:
        // passing unverified bytes on is exactly what produces a scrambled picture.
        post({
          type: "cipher-error", id, op, kind,
          message: String((error && error.message) || error),
        });
        flush(false);
        continue;
      }

      flush(false);
      await writer.write(frame);
    }
  };

  pump().catch((error) => {
    post({ type: "cipher-error", id, op, kind, message: String((error && error.message) || error) });
  });
};
`;
