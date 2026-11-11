"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  cipherState,
  forgetKey,
  enableEncryption,
  enableEncryptionWithKey,
  generateKeyString,
  keyStringFingerprint,
  passphraseFingerprint,
  serverCipherState,
  subscribeCipherState,
} from "@/lib/media-cipher";

type Mode = "passphrase" | "key";

export type EncryptionSummary = {
  icon: string;
  badge: string;
  line: string;
  tone: "off" | "warn" | "on";
};

/**
 * What to tell the user about the call as a whole, not just about this browser.
 *
 * Holding a key only means *our* media is sealed. If a peer is sending in the clear, or
 * sealing with a different secret, a padlock here would be a lie — so those outrank our
 * own state.
 */
export function encryptionSummary(state: ReturnType<typeof useCipherState>): EncryptionSummary {
  const code = state.keyId ?? "…";

  if (!state.hasKey) {
    return state.lockedStreams > 0
      ? {
          icon: "🔓",
          badge: "Enter secret",
          line: "Someone encrypted their stream. Enter the same secret to see and hear them.",
          tone: "warn",
        }
      : {
          icon: "🔓",
          badge: "Encrypt call",
          line: "Not encrypted — anyone carrying this call can see and hear it.",
          tone: "off",
        };
  }

  if (state.lockedStreams > 0) {
    return {
      icon: "⚠",
      badge: `Partly encrypted · ${code}`,
      line: "Someone is using a different secret — their stream cannot be read here.",
      tone: "warn",
    };
  }

  if (state.plaintextStreams > 0) {
    return {
      icon: "⚠",
      badge: `Partly encrypted · ${code}`,
      line: "You are encrypted, but someone else is sending in the clear.",
      tone: "warn",
    };
  }

  return {
    icon: "🔒",
    badge: `Encrypted · ${code}`,
    line: "Encrypted both ways in this browser, before Vonage carries it.",
    tone: "on",
  };
}

export function useCipherState() {
  return useSyncExternalStore(subscribeCipherState, cipherState, serverCipherState);
}

/** The header control: shows whether this call is in the clear, and opens the passphrase box. */
export function EncryptionControl() {
  const state = useCipherState();
  const [open, setOpen] = useState(false);

  const summary = encryptionSummary(state);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-encryption-control
        className={`rounded-full border px-4 py-2 text-sm transition ${
          summary.tone === "on"
            ? "border-[#d6f25c]/50 bg-[#d6f25c]/10 text-[#d6f25c]"
            : summary.tone === "warn"
              ? "border-[#ffb4a8]/50 bg-[#ffb4a8]/10 text-[#ffb4a8]"
              : "border-white/15 hover:bg-white/5"
        }`}
      >
        {summary.icon} {summary.badge}
      </button>
      {open ? <PassphraseDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PassphraseDialog({ onClose }: { onClose: () => void }) {
  const state = useCipherState();
  const [mode, setMode] = useState<Mode>("passphrase");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [copied, setCopied] = useState(false);

  // Joining encryption someone else already turned on is a different task from starting
  // it, even though the value you type is the same. Generating a key here would produce
  // one that matches nobody, so that affordance is removed in this case.
  const joining = !state.hasKey && state.lockedStreams > 0;

  // The check code both sides read to each other. Debounced, because deriving a key from
  // a passphrase is 600k PBKDF2 rounds and we do it on every keystroke otherwise.
  const tooShort = mode === "passphrase" ? value.length < 4 : value.trim().length < 20;
  useEffect(() => {
    if (tooShort) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const work = mode === "passphrase" ? passphraseFingerprint(value) : keyStringFingerprint(value);
      work.then(
        (tag) => active && setPreview(tag),
        () => active && setPreview(""),
      );
    }, mode === "passphrase" ? 400 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [value, mode, tooShort]);
  const checkCode = tooShort ? "" : preview;

  function switchMode(next: Mode) {
    setMode(next);
    setValue("");
    setPreview("");
    setError("");
    setCopied(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "passphrase") {
        if (value.length < 4) throw new Error("Use at least 4 characters.");
        await enableEncryption(value);
      } else {
        enableEncryptionWithKey(value);
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not turn on encryption.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-5"
      onClick={onClose}
      role="presentation"
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1c2116] p-6"
      >
        <p className="font-display text-2xl tracking-tight">
          {state.hasKey ? "Encryption is on" : joining ? "Unlock this call" : "Encrypt this call"}
        </p>
        <p className="mt-2 text-sm leading-6 text-[#a3aa94]">
          {joining ? (
            <>
              Someone in this room has turned encryption on. Enter the{" "}
              <strong className="font-medium text-[#c9cdb8]">same secret they used</strong> to
              see and hear them — ask them for it directly, not over this call.
            </>
          ) : (
            <>
              One secret covers everyone. Whoever has it can both send and read encrypted
              media; anyone without it sees a locked tile. It never reaches our server or
              Vonage.
            </>
          )}
        </p>

        <div className="mt-5 flex gap-1 rounded-full border border-white/10 p-1 text-sm">
          {(["passphrase", "key"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => switchMode(option)}
              aria-pressed={mode === option}
              className={`flex-1 rounded-full px-3 py-2 transition ${
                mode === option ? "bg-[#d6f25c] font-medium text-[#172000]" : "text-[#a3aa94] hover:bg-white/5"
              }`}
            >
              {option === "passphrase" ? "Passphrase" : "My own key"}
            </button>
          ))}
        </div>

        {mode === "passphrase" ? (
          <>
            <label className="mt-4 block text-sm text-[#a3aa94]" htmlFor="secret">
              Passphrase
            </label>
            <input
              id="secret"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              autoComplete="off"
              className="mt-2 w-full rounded-2xl border border-white/10 bg-[#12140e] px-4 py-3 outline-none ring-[#d6f25c] focus:ring-2"
            />
            <p className="mt-2 text-xs leading-5 text-[#6e7564]">
              Stretched with PBKDF2 (600,000 rounds) and salted with the room name.
            </p>
          </>
        ) : (
          <>
            <label className="mt-4 block text-sm text-[#a3aa94]" htmlFor="secret">
              32-byte key — base64url or hex
            </label>
            <textarea
              id="secret"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              rows={3}
              spellCheck={false}
              placeholder="paste a key, or generate one"
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-[#12140e] px-4 py-3 font-mono text-xs break-all outline-none ring-[#d6f25c] placeholder:text-[#6e7564] focus:ring-2"
            />
            <div className="mt-2 flex gap-2">
              {joining ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setValue(generateKeyString());
                    setCopied(false);
                  }}
                  className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-[#a3aa94] hover:bg-white/5"
                >
                  Generate
                </button>
              )}
              <button
                type="button"
                disabled={!value.trim()}
                onClick={() => {
                  void navigator.clipboard.writeText(value.trim()).then(
                    () => setCopied(true),
                    () => setError("Could not copy — select the key and copy it by hand."),
                  );
                }}
                className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-[#a3aa94] hover:bg-white/5 disabled:opacity-40"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#6e7564]">
              {joining
                ? "Paste the key the other person generated. A new one will not match."
                : "Used as-is, with no stretching — so it must be 32 random bytes, not a word."}
            </p>
          </>
        )}

        {checkCode ? (
          <p className="mt-3 font-mono text-xs text-[#a3aa94]">
            Check code <span className="text-[#d6f25c]">{checkCode}</span> —{" "}
            {joining ? "must match the code on their screen." : "this must match on every screen."}
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-[#ffb4a8]">{error}</p> : null}

        <div className="mt-5 flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-full bg-[#d6f25c] px-5 py-3 font-medium text-[#172000] disabled:opacity-50"
          >
            {busy ? "Deriving key…" : state.hasKey ? "Change secret" : joining ? "Unlock" : "Turn on encryption"}
          </button>
          {state.hasKey ? (
            <button
              type="button"
              onClick={() => {
                forgetKey();
                onClose();
              }}
              className="rounded-full border border-white/15 px-4 py-3 text-sm hover:bg-white/5"
            >
              Stop encrypting
            </button>
          ) : null}
        </div>
        {state.hasKey ? (
          <p className="mt-4 text-xs leading-5 text-[#6e7564]">
            Your camera and microphone are sealed in this browser before Vonage carries
            them. Stopping drops the key, so people who are still encrypting will no longer
            be visible to you.
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** Covers a remote tile whose owner has encryption on while we do not. */
export function LockedTileOverlay({ name, onUnlock }: { name: string; onUnlock: () => void }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-[#12140e]/95 px-6 text-center">
      <div>
        <p className="text-4xl">🔒</p>
        <p className="font-display mt-3 text-2xl tracking-tight">{name} encrypted their stream</p>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#a3aa94]">
          Enter the same passphrase to see and hear them again.
        </p>
        <button
          type="button"
          onClick={onUnlock}
          className="mt-5 rounded-full bg-[#d6f25c] px-5 py-3 text-sm font-medium text-[#172000]"
        >
          Enter passphrase
        </button>
      </div>
    </div>
  );
}

/** Marks one tile whose owner is sending unencrypted media while we are encrypted. */
export function ClearStreamBadge() {
  return (
    <p className="absolute top-4 left-4 z-10 rounded-full border border-[#ffb4a8]/40 bg-[#ffb4a8]/15 px-3 py-1 text-xs font-medium text-[#ffb4a8] backdrop-blur">
      ⚠ Not encrypted
    </p>
  );
}
