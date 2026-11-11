import type {
  CipherAlgorithm,
  CipherKind,
  CipherLogEntry,
  CipherLogEvent,
  CipherOp,
  CipherStream,
} from "./types.js";

const MAX_ENTRIES = 80;
const STYLE = {
  encrypt: "background:#d6f25c;color:#172000;border-radius:3px;font-weight:600",
  decrypt: "background:#7cc6ff;color:#00172a;border-radius:3px;font-weight:600",
  warn: "background:#ffb4a8;color:#2a0b05;border-radius:3px;font-weight:600",
};

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/** `out` means sealed here before it leaves; `in` means opened here before the decoder sees it. */
export function directionOf(op: CipherOp): "out" | "in" {
  return op === "encrypt" ? "out" : "in";
}

export type CipherSnapshot = { streams: CipherStream[]; entries: CipherLogEntry[] };

export const EMPTY_SNAPSHOT: CipherSnapshot = Object.freeze({ streams: [], entries: [] });

export class CipherLog {
  private readonly streams = new Map<number, CipherStream>();
  private readonly entries: CipherLogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private current: CipherSnapshot = EMPTY_SNAPSHOT;

  constructor(private readonly useConsole: boolean) {}

  snapshot = (): CipherSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish() {
    this.current = { streams: [...this.streams.values()], entries: [...this.entries] };
    for (const listener of this.listeners) listener();
  }

  private write(level: CipherLogEntry["level"], text: string, event: CipherLogEvent, detail?: string) {
    this.seq += 1;
    const entry: CipherLogEntry = { seq: this.seq, at: Date.now(), level, text, detail, event };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    return entry;
  }

  private say(op: CipherOp | "warn", message: string, ...rest: unknown[]) {
    if (!this.useConsole) return;
    const style = op === "warn" ? STYLE.warn : STYLE[op];
    console.log(`%c cipher %c ${message}`, style, "", ...rest);
  }

  /** Feeds one worker message in and returns the entry it produced, if any. */
  handle(message: Record<string, unknown>): CipherLogEntry | null {
    const type = String(message.type ?? "");
    if (!type.startsWith("cipher-")) return null;

    const id = Number(message.id);
    const op = message.op as CipherOp;
    const kind = message.kind as CipherKind;
    let entry: CipherLogEntry | null = null;

    switch (type) {
      case "cipher-open": {
        const keyId = message.keyId == null ? "" : String(message.keyId);
        const algorithm = message.algorithm as CipherAlgorithm;
        const senderId = String(message.senderId ?? "");
        const trackId = String(message.trackId ?? "");
        const fullFrame = Boolean(message.fullFrame);
        const canForceKeyFrame = Boolean(message.canForceKeyFrame);
        this.streams.set(id, {
          id, op, kind, keyId, algorithm, senderId, trackId, fullFrame, canForceKeyFrame,
          frames: 0, inBytes: 0, outBytes: 0, keyFrames: 0,
          passthrough: 0, dropped: 0, mismatched: 0, replayed: 0,
          staleGeneration: 0, failed: 0, cryptoMs: 0, generation: 0, reasons: {},
          locked: 0, plaintext: 0, secured: 0,
          recentLocked: 0, recentSecured: 0, recentPlaintext: 0,
          sendingNow: 0, hasSchedule: 0,
          open: true, startedAt: Date.now(),
        });
        const scope = fullFrame ? "whole frame" : "body, codec header left readable";
        const what = op === "encrypt"
          ? `sealing outgoing ${kind} before it leaves this browser`
          : `opening incoming ${kind} before it reaches the decoder`;
        entry = this.write(
          "info",
          `#${id} ${directionOf(op)} ${kind} · ${algorithm}`,
          { type: "open", id, op, kind, keyId, algorithm, senderId, fullFrame },
          `key ${keyId} · sender ${senderId} · ${scope} · ${what}`,
        );
        this.say(op, `#${id} ${what} (${algorithm}, key ${keyId}, sender ${senderId})`);
        break;
      }

      case "cipher-close": {
        const stream = this.streams.get(id);
        if (stream) stream.open = false;
        entry = this.write("info", `#${id} ${directionOf(op)} ${kind} ended`, { type: "close", id, op, kind });
        this.say(op, `#${id} ${kind} ${op} ended`);
        break;
      }

      case "cipher-stats": {
        const stream = this.streams.get(id);
        if (!stream) break;
        for (const field of [
          "frames", "inBytes", "outBytes", "keyFrames",
          "passthrough", "dropped", "mismatched", "replayed",
          "staleGeneration", "failed", "cryptoMs", "generation",
          "locked", "plaintext", "secured",
          "recentLocked", "recentSecured", "recentPlaintext",
          "sendingNow", "hasSchedule",
        ] as const) {
          const value = message[field];
          if (typeof value === "number") stream[field] = value;
        }
        if (message.reasons && typeof message.reasons === "object") {
          stream.reasons = message.reasons as Record<string, number>;
        }
        break;
      }

      case "cipher-frame": {
        const event = { ...(message as object), type: "frame" } as Extract<CipherLogEvent, { type: "frame" }>;
        const arrow = op === "encrypt" ? "plain → sealed" : "sealed → plain";
        const overhead = event.outBytes - event.inBytes;
        const label = event.frameType ?? kind;
        const detail =
          `${label} · header ${event.headerBytes}B kept clear (${event.clearHex}) · ` +
          `body ${event.beforeHex} → ${event.afterHex} · ` +
          `${event.inBytes}B → ${event.outBytes}B (${overhead >= 0 ? "+" : ""}${overhead}) · ` +
          `gen ${event.generation} #${event.counter} · ${event.ms}ms`;
        entry = this.write("frame", `#${id} ${directionOf(op)} ${kind} frame ${event.seq} ${arrow}`, event, detail);
        this.say(op, `#${id} ${kind} frame ${event.seq} (${label}) ${arrow}`, {
          headerKeptClear: `${event.headerBytes}B ${event.clearHex}`,
          bodyBefore: event.beforeHex,
          bodyAfter: event.afterHex,
          bytes: `${event.inBytes} → ${event.outBytes}`,
          generation: event.generation,
          counter: event.counter,
          ms: event.ms,
        });
        break;
      }

      case "cipher-key-mismatch": {
        const saw = String(message.saw);
        const want = String(message.want);
        const text = `#${id} ${kind} sealed with another key`;
        const detail = `frame carries key ${saw}, this endpoint holds ${want} — dropping these frames`;
        entry = this.write("error", text, { type: "key-mismatch", id, kind, saw, want }, detail);
        this.say("warn", `${text}: ${detail}`);
        break;
      }

      case "cipher-error": {
        const text = String(message.message);
        entry = this.write("error", `#${id} ${kind} ${op} failed`, { type: "error", id, op, kind, message: text }, text);
        this.say("warn", `#${id} ${kind} ${op} failed: ${text}`);
        break;
      }

      default:
        return null;
    }

    this.publish();
    return entry;
  }
}
