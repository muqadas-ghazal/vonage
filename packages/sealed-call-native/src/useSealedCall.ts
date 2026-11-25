import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  INITIAL_STATE,
  type HostMessage,
  type KeyMode,
  type PageMessage,
  type SealedState,
  type TrackState,
} from "./protocol";

/**
 * What the WebView and the page are doing, as opposed to what the cipher is doing.
 *
 * Kept separate from SealedState because a page that never loaded has no cipher state at
 * all, and that is exactly the case worth being able to see.
 */
export type PageDiagnostics = {
  /** The WebView finished loading the document. */
  loaded: boolean;
  /** Non-null when the server answered with an error status. */
  httpStatus: number | null;
  /** Last progress line from the page. */
  status: string;
  /** What the WebView can see and open: device counts and per-kind getUserMedia results. */
  media: string;
  /** Last failure, from the page or the WebView itself. */
  error: string;
};

export const INITIAL_PAGE: PageDiagnostics = {
  loaded: false,
  httpStatus: null,
  status: "",
  media: "",
  error: "",
};

export type SealedCallController = {
  state: SealedState;
  page: PageDiagnostics;
  /**
   * Turns encryption on. `"passphrase"` is stretched with PBKDF2 and salted with the room
   * name by the page; `"raw"` takes a 43-character base64url or 64-character hex key.
   *
   * The value crosses into the WebView and is never stored, logged, or sent back.
   */
  setKey(value: string, mode?: KeyMode): void;
  /**
   * Drops the key. We stop sealing and can no longer open sealed peers.
   *
   * This is deliberately the only way to stop encrypting: keeping the key while sending in
   * the clear looks secure on your own screen while your camera goes out unprotected.
   */
  forgetKey(): void;
  /** The short digest to read aloud, so both sides can confirm they typed the same thing. */
  fingerprint(value: string, mode?: KeyMode): Promise<string>;
  setVerbose(value: boolean): void;
  /** Ask the page to re-send its state. Useful after returning from the background. */
  sync(): void;
  /**
   * Tell the page the app is in the foreground again, so it can re-acquire the camera and
   * re-publish its state. `<SealedCall>` calls this from AppState.
   */
  resume(): void;
  trackState(trackId: string): TrackState;
  /** @internal wiring for <SealedCall>. */
  readonly internal: {
    bind(send: ((message: HostMessage) => void) | null): void;
    ingest(message: PageMessage): void;
    note(partial: Partial<PageDiagnostics>): void;
    reset(): void;
  };
};

export type UseSealedCallOptions = {
  onStateChange?: (state: SealedState) => void;
  /** Called when the device cannot seal at all, with a message safe to show a user. */
  onUnsupported?: (reason: string) => void;
};

/**
 * Holds the call's encryption state on the React Native side.
 *
 * The state lives here rather than in the WebView so your lock badges, locked-tile
 * overlays and passphrase screens are real native components. The page is the source of
 * truth — it owns the cipher — and it pushes every change across.
 */
export function useSealedCall(options: UseSealedCallOptions = {}): SealedCallController {
  const [state, setState] = useState<SealedState>(INITIAL_STATE);
  const [page, setPage] = useState<PageDiagnostics>(INITIAL_PAGE);

  const send = useRef<((message: HostMessage) => void) | null>(null);
  const queue = useRef<HostMessage[]>([]);
  const pending = useRef(new Map<string, { resolve(value: string): void; reject(error: Error): void }>());
  const nonce = useRef(0);

  /**
   * The key last given to the page, so it can be restored if the page reloads.
   *
   * iOS kills a WebView's content process under memory pressure and the page comes back
   * fresh — new worker, no key. Without this the call silently reverts to plaintext while
   * the shell, having reset its state, shows "connecting" and then "clear". Nobody would
   * notice they had stopped being encrypted, which is worse than the cost of holding the
   * secret in memory for the length of the call. Cleared by forgetKey().
   */
  const lastKey = useRef<{ mode: KeyMode; value: string } | null>(null);
  const callbacks = useRef(options);
  // Written in an effect, not during render: the callbacks are only ever read from
  // message handlers, which run well after commit.
  useEffect(() => {
    callbacks.current = options;
  }, [options]);

  const post = useCallback((message: HostMessage) => {
    const target = send.current;
    // The WebView may not be mounted yet when the user acts. Queue rather than drop:
    // a lost key leaves the tile locked with no way for the user to tell why.
    if (target) target.call(null, message);
    else queue.current.push(message);
  }, []);

  const internal = useMemo(
    () => ({
      bind(next: ((message: HostMessage) => void) | null) {
        send.current = next;
        if (!next) return;
        const waiting = queue.current;
        queue.current = [];
        for (const message of waiting) next(message);
      },
      note(partial: Partial<PageDiagnostics>) {
        setPage((current) => ({ ...current, ...partial }));
      },
      ingest(message: PageMessage) {
        if (message.t === "status") {
          setPage((current) => ({ ...current, status: message.text }));
          return;
        }
        if (message.t === "media") {
          setPage((current) => ({ ...current, media: message.report }));
          return;
        }
        if (message.t === "state") {
          setState(message.state);
          callbacks.current.onStateChange?.(message.state);
          return;
        }
        if (message.t === "ready") {
          setPage((current) => ({ ...current, loaded: true }));
          // The page has booted — possibly a reload that lost the key. Put it back.
          const held = lastKey.current;
          if (held) post({ t: "key", mode: held.mode, value: held.value });
          if (!message.supported) {
            const reason = message.reason ?? "This device cannot encrypt call media.";
            setState((current) => ({ ...current, status: "unsupported" }));
            callbacks.current.onUnsupported?.(reason);
          }
          return;
        }
        if (message.t === "fingerprint") {
          pending.current.get(message.nonce)?.resolve(message.value);
          pending.current.delete(message.nonce);
          return;
        }
        if (message.t === "error") {
          setPage((current) => ({ ...current, error: message.message }));
          if (message.nonce) {
            pending.current.get(message.nonce)?.reject(new Error(message.message));
            pending.current.delete(message.nonce);
          }
        }
      },
      reset() {
        setState(INITIAL_STATE);
        setPage(INITIAL_PAGE);
        for (const entry of pending.current.values()) {
          entry.reject(new Error("The call page reloaded."));
        }
        pending.current.clear();
      },
    }),
    [post],
  );

  return useMemo<SealedCallController>(
    () => ({
      state,
      page,
      setKey(value, mode = "passphrase") {
        lastKey.current = { mode, value };
        post({ t: "key", mode, value });
      },
      forgetKey() {
        lastKey.current = null;
        post({ t: "forget" });
      },
      fingerprint(value, mode = "passphrase") {
        nonce.current += 1;
        const id = `fp-${nonce.current}`;
        return new Promise<string>((resolve, reject) => {
          pending.current.set(id, { resolve, reject });
          post({ t: "fingerprint", mode, value, nonce: id });
          setTimeout(() => {
            if (!pending.current.has(id)) return;
            pending.current.delete(id);
            reject(new Error("The call page did not answer in time."));
          }, 10_000);
        });
      },
      setVerbose(value) {
        post({ t: "verbose", value });
      },
      sync() {
        post({ t: "sync" });
      },
      resume() {
        post({ t: "resume" });
      },
      trackState(trackId) {
        return state.tracks.find((track) => track.trackId === trackId)?.state ?? "unknown";
      },
      internal,
    }),
    [state, page, post, internal],
  );
}
