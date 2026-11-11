"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { readName, saveName, serverName, subscribeName } from "@/lib/browser-name";
import { isValidRoom, normalizeName, normalizeRoom, suggestRoom } from "@/lib/room-name";

let suggestedRoom = "";

function subscribeSuggested() {
  return () => {};
}

function readSuggestedRoom() {
  if (!suggestedRoom) suggestedRoom = suggestRoom();
  return suggestedRoom;
}

export function Lobby() {
  const router = useRouter();
  const storedName = useSyncExternalStore(subscribeName, readName, serverName);
  const suggested = useSyncExternalStore(subscribeSuggested, readSuggestedRoom, () => "");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [roomOverride, setRoomOverride] = useState<string | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const name = nameOverride ?? storedName ?? "";
  const room = roomOverride ?? suggested;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => response.json())
      .then((body: { ready?: boolean; message?: string }) => {
        if (cancelled) return;
        setSetupMessage(body.ready ? null : body.message || "Vonage is not configured yet.");
      })
      .catch(() => {
        if (!cancelled) setSetupMessage("Could not check the Vonage configuration.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = normalizeName(name);
    const nextRoom = normalizeRoom(room);

    if (nextName.length < 1) {
      setError("Enter the name the other person should see.");
      return;
    }
    if (!isValidRoom(nextRoom)) {
      setError("Use a room name with at least 3 letters or numbers.");
      return;
    }

    saveName(nextName);
    router.push(`/call/${nextRoom}`);
  }

  return (
    <main className="relative min-h-dvh overflow-hidden px-5 py-6 sm:px-8">
      <div className="pointer-events-none absolute -top-24 right-[-10%] h-80 w-80 rounded-full bg-[#d6f25c]/15 blur-3xl" />
      <header className="relative flex items-center justify-between">
        <p className="font-display text-2xl tracking-tight">Booth</p>
        <p className="text-sm text-[#a3aa94]">Vonage video</p>
      </header>

      <section className="relative mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-xl flex-col justify-center py-10">
        <p className="text-sm font-medium tracking-[0.18em] text-[#d6f25c] uppercase">
          One link, two browsers
        </p>
        <h1 className="font-display mt-4 text-5xl leading-[1.05] tracking-tight sm:text-6xl">
          Open the same room and you are on a call.
        </h1>
        <p className="mt-5 max-w-md text-lg leading-7 text-[#c9cdb8]">
          Start a room here, then open that same address in a second browser.
          Both sides publish camera and microphone into one Vonage session.
        </p>

        {setupMessage ? (
          <div className="mt-8 rounded-2xl border border-[#d6f25c]/30 bg-[#d6f25c]/10 px-4 py-3 text-sm leading-6 text-[#f4f1e6]">
            {setupMessage} Restart the dev server after saving <code>.env.local</code>.
          </div>
        ) : null}

        <form
          onSubmit={openRoom}
          className="mt-8 rounded-3xl border border-white/10 bg-[#1c2116]/90 p-5 shadow-2xl shadow-black/30"
        >
          <label className="block text-sm text-[#a3aa94]" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            value={name}
            onChange={(event) => setNameOverride(event.target.value)}
            autoComplete="nickname"
            maxLength={32}
            placeholder="Ada"
            className="mt-2 w-full rounded-2xl border border-white/10 bg-[#12140e] px-4 py-3 outline-none ring-[#d6f25c] placeholder:text-[#6e7564] focus:ring-2"
          />

          <label className="mt-5 block text-sm text-[#a3aa94]" htmlFor="room">
            Room name
          </label>
          <input
            id="room"
            value={room}
            onChange={(event) => setRoomOverride(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            placeholder="amber-harbor"
            className="mt-2 w-full rounded-2xl border border-white/10 bg-[#12140e] px-4 py-3 font-mono text-sm outline-none ring-[#d6f25c] placeholder:text-[#6e7564] focus:ring-2"
          />

          {error ? <p className="mt-4 text-sm text-[#ffb4a8]">{error}</p> : null}

          <button
            type="submit"
            className="mt-5 w-full rounded-full bg-[#d6f25c] px-5 py-3 font-medium text-[#172000] transition hover:bg-[#e4ff7a]"
          >
            Open room
          </button>
          <p className="mt-4 text-sm leading-6 text-[#a3aa94]">
            The other person does not need an account. They open the room link,
            enter their name, and join the same call.
          </p>
        </form>
      </section>
    </main>
  );
}
