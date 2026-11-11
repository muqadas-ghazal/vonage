"use client";

import { directionOf, formatBytes, type CipherStream } from "@booth/frame-cipher";
import { useCipherLog } from "@booth/frame-cipher/react";
import { isCipherVerbose, mediaCipher, setCipherVerbose } from "@/lib/media-cipher";

function Row({ stream }: { stream: CipherStream }) {
  const outgoing = stream.op === "encrypt";
  const overhead = stream.frames > 0 ? (stream.outBytes - stream.inBytes) / stream.frames : 0;
  const perFrame = stream.frames > 0 ? (stream.cryptoMs / stream.frames) * 1000 : 0;

  return (
    <div className="flex items-baseline gap-2 border-t border-white/10 py-1.5 first:border-t-0">
      <span
        className={`w-9 shrink-0 rounded px-1 text-center text-[10px] font-semibold ${
          outgoing ? "bg-[#d6f25c] text-[#172000]" : "bg-[#7cc6ff] text-[#00172a]"
        }`}
      >
        {directionOf(stream.op)}
      </span>
      <span className="w-10 shrink-0 text-[#c9cdb8]">{stream.kind}</span>
      <span className="shrink-0 text-[#6e7564]">g{stream.generation}</span>
      <span className="flex-1 tabular-nums text-[#a3aa94]">
        {stream.frames.toLocaleString()} frames · {formatBytes(outgoing ? stream.outBytes : stream.inBytes)}
        {stream.keyFrames > 0 ? ` · ${stream.keyFrames} key` : ""}
      </span>
      <span className="shrink-0 tabular-nums text-[#6e7564]">
        {overhead !== 0 ? `${overhead > 0 ? "+" : ""}${overhead.toFixed(0)}B` : "—"} ·{" "}
        {perFrame.toFixed(0)}µs
      </span>
      {stream.failed > 0 ? (
        <span className="shrink-0 text-[#ffb4a8]">{stream.failed} bad auth</span>
      ) : null}
      {stream.replayed > 0 ? (
        <span className="shrink-0 text-[#ffb4a8]">{stream.replayed} replay</span>
      ) : null}
      {stream.staleGeneration > 0 ? (
        <span className="shrink-0 text-[#ffb4a8]">{stream.staleGeneration} stale</span>
      ) : null}
      {!stream.open ? <span className="shrink-0 text-[#6e7564]">ended</span> : null}
    </div>
  );
}

export function CipherPanel({ onClose }: { onClose: () => void }) {
  const { streams, entries } = useCipherLog(mediaCipher());
  const verbose = isCipherVerbose();
  // Renegotiation leaves older transforms behind; only the ones carrying frames are interesting.
  const live = streams.filter((stream) => stream.open && stream.frames > 0);
  const idle = streams.length - live.length;
  const sealed = live.filter((stream) => stream.op === "encrypt");
  const opened = live.filter((stream) => stream.op === "decrypt");

  return (
    <aside className="pointer-events-auto absolute top-4 left-4 z-20 flex max-h-[min(32rem,calc(100%-2rem))] w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/85 font-mono text-[11px] leading-5 backdrop-blur">
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <p className="font-sans text-xs font-medium tracking-wide text-[#d6f25c]">Cipher flow</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCipherVerbose(!verbose)}
            className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-[#a3aa94] hover:bg-white/5"
          >
            {verbose ? "every frame" : "sampled"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide the cipher flow panel"
            className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-[#a3aa94] hover:bg-white/5"
          >
            hide
          </button>
        </div>
      </header>

      <div className="overflow-y-auto px-3 py-2">
        <p className="font-sans text-[10px] tracking-wide text-[#6e7564] uppercase">
          Encrypted here before Vonage
          {sealed[0] ? ` · AES-GCM · key ${sealed[0].keyId} · sender ${sealed[0].senderId}` : ""}
        </p>
        {sealed.length > 0 ? (
          sealed.map((stream) => <Row key={stream.id} stream={stream} />)
        ) : (
          <p className="py-1.5 text-[#6e7564]">no outgoing track yet</p>
        )}

        <p className="mt-3 font-sans text-[10px] tracking-wide text-[#6e7564] uppercase">
          Decrypted here after Vonage
        </p>
        {opened.length > 0 ? (
          opened.map((stream) => <Row key={stream.id} stream={stream} />)
        ) : (
          <p className="py-1.5 text-[#6e7564]">no incoming track yet</p>
        )}

        {idle > 0 ? (
          <p className="mt-2 text-[#6e7564]">
            + {idle} transform{idle === 1 ? "" : "s"} idle or ended after renegotiation
          </p>
        ) : null}

        <p className="mt-3 font-sans text-[10px] tracking-wide text-[#6e7564] uppercase">Recent</p>
        <ul className="mt-1 space-y-1">
          {entries.length === 0 ? <li className="text-[#6e7564]">waiting for frames…</li> : null}
          {entries.map((entry) => (
            <li
              key={entry.seq}
              className={
                entry.level === "error"
                  ? "text-[#ffb4a8]"
                  : entry.level === "frame"
                    ? "text-[#c9cdb8]"
                    : "text-[#a3aa94]"
              }
            >
              <span className="text-[#6e7564]">
                {new Date(entry.at).toLocaleTimeString([], { hour12: false })}{" "}
              </span>
              {entry.text}
              {entry.detail ? (
                <span className="block pl-[4.5rem] break-all text-[#6e7564]">{entry.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
