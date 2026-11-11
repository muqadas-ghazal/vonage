import { useSyncExternalStore } from "react";
import { EMPTY_SNAPSHOT, type CipherSnapshot } from "./log.js";
import type { FrameCipher } from "./cipher.js";

const emptySnapshot = () => EMPTY_SNAPSHOT;

/**
 * Live cipher stats for a React UI. Safe during SSR: it reports an empty snapshot on the server.
 * Pass null before the cipher exists.
 */
export function useCipherLog(cipher: FrameCipher | null): CipherSnapshot {
  return useSyncExternalStore(
    cipher ? cipher.subscribe : noopSubscribe,
    cipher ? cipher.snapshot : emptySnapshot,
    emptySnapshot,
  );
}

function noopSubscribe() {
  return () => {};
}
