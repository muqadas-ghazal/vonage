export { createFrameCipher, frameCipherSupport, isFrameCipherSupported } from "./cipher.js";
export type { FrameCipher } from "./cipher.js";

export {
  MEDIA_KEY_BYTES,
  decodeMediaKey,
  encodeMediaKey,
  ensureMediaKey,
  generateMediaKey,
  mediaKeyFingerprint,
  readKeyFromFragment,
  withKeyFragment,
} from "./keys.js";
export type { EnsureKeyOptions } from "./keys.js";

export { EMPTY_SNAPSHOT, directionOf, formatBytes } from "./log.js";
export type { CipherSnapshot } from "./log.js";

export { WORKER_SOURCE } from "./worker-source.js";

export type {
  CipherAlgorithm,
  CipherKind,
  CipherLogEntry,
  CipherLogEvent,
  CipherLogLevel,
  CipherOp,
  CipherStream,
  FrameCipherOptions,
  FrameCipherSupport,
  KeyMismatch,
} from "./types.js";
