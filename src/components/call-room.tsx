"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { readName, saveName, serverName, subscribeName } from "@/lib/browser-name";
import {
  armMediaCipher,
  ensureSharedKey,
  hasKeyMismatch,
  rekeyOnMembershipChange,
  roomLink,
  subscribeKeyMismatch,
} from "@/lib/media-cipher";
import { normalizeName } from "@/lib/room-name";
import { CipherPanel } from "./cipher-panel";

type OTApi = typeof import("@vonage/client-sdk-video");
type Session = ReturnType<OTApi["initSession"]>;
type Publisher = ReturnType<OTApi["initPublisher"]>;
type Stream = Parameters<Session["subscribe"]>[0];
type Person = { connectionId: string; name: string };

type Credentials = {
  apiKey: string;
  sessionId: string;
  token: string;
};

async function loadOT(): Promise<OTApi> {
  const loaded = (await import("@vonage/client-sdk-video")) as OTApi & {
    default?: OTApi;
  };
  return loaded.default ?? loaded;
}

function nameFromData(data: string | undefined): string {
  const raw = data?.match(/(?:^|[;&])name=([^;&]*)/)?.[1];
  if (!raw) return "Guest";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function CallRoom({ room }: { room: string }) {
  const router = useRouter();
  const storedName = useSyncExternalStore(subscribeName, readName, serverName);
  const [draftName, setDraftName] = useState("");
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState("");
  const [mediaNote, setMediaNote] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [readyToPublish, setReadyToPublish] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyNote, setCopyNote] = useState("");
  const [hearPrompt, setHearPrompt] = useState(false);
  const [showCipherLog, setShowCipherLog] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("cipherlog"),
  );
  const reportAudioBlocked = useCallback(() => setHearPrompt(true), []);
  const publisherNode = useRef<HTMLDivElement>(null);
  const publisher = useRef<Publisher | null>(null);

  const keyMismatch = useSyncExternalStore(subscribeKeyMismatch, hasKeyMismatch, () => false);

  useEffect(() => {
    ensureSharedKey();
  }, []);

  useEffect(() => {
    if (!storedName) return;
    const target = publisherNode.current;
    if (!target) return;

    const resources: { publisher: Publisher | null; session: Session | null } = {
      publisher: null,
      session: null,
    };
    let cancelled = false;

    setStatus("connecting");
    setError("");
    setMediaNote("");
    setStreams([]);
    setPeople([]);
    setReadyToPublish(false);

    (async () => {
      try {
        armMediaCipher();
        const OT = await loadOT();
        if (cancelled) return;

        resources.publisher = OT.initPublisher(
          target,
          {
            insertMode: "append",
            width: "100%",
            height: "100%",
            fitMode: "cover",
            name: storedName,
            resolution: "1280x720",
            showControls: false,
          },
          (publishError) => {
            if (cancelled || !publishError) return;
            setMediaNote(
              "Camera or microphone is unavailable. You can still see and hear the other person.",
            );
            setVideoOn(false);
            setAudioOn(false);
          },
        );
        publisher.current = resources.publisher;
        if (cancelled) {
          resources.publisher.destroy();
          return;
        }

        const response = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room, name: storedName }),
        });
        const body = (await response.json()) as Credentials & { error?: string };
        if (cancelled) return;
        if (!response.ok || !body.token) {
          throw new Error(body.error || "Could not join this room.");
        }

        const nextSession = OT.initSession(body.apiKey, body.sessionId);
        resources.session = nextSession;

        nextSession.on("streamCreated", (event) => {
          setStreams((current) =>
            current.some((stream) => stream.streamId === event.stream.streamId)
              ? current
              : [...current, event.stream],
          );
        });
        nextSession.on("streamDestroyed", (event) => {
          setStreams((current) =>
            current.filter((stream) => stream.streamId !== event.stream.streamId),
          );
        });
        nextSession.on("connectionCreated", (event) => {
          rekeyOnMembershipChange();
          const person = {
            connectionId: event.connection.connectionId,
            name: nameFromData(event.connection.data),
          };
          setPeople((current) =>
            current.some((item) => item.connectionId === person.connectionId)
              ? current
              : [...current, person],
          );
        });
        nextSession.on("connectionDestroyed", (event) => {
          rekeyOnMembershipChange();
          setPeople((current) =>
            current.filter((item) => item.connectionId !== event.connection.connectionId),
          );
        });

        nextSession.connect(body.token, (connectError) => {
          if (cancelled) return;
          if (connectError) {
            setStatus("error");
            setError(connectError.message);
            return;
          }
          setSession(nextSession);
          setStatus("live");
          if (!resources.publisher) return;
          nextSession.publish(resources.publisher, (publishError) => {
            if (cancelled) return;
            if (publishError) {
              setMediaNote(publishError.message);
              return;
            }
            setReadyToPublish(true);
          });
        });
      } catch (caught) {
        if (cancelled) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Could not join this room.");
      }
    })();

    return () => {
      cancelled = true;
      publisher.current = null;
      resources.publisher?.destroy();
      void resources.session?.disconnect();
    };
  }, [room, storedName]);

  async function copyLink() {
    const url = roomLink(room);
    try {
      await navigator.clipboard.writeText(url);
      setCopyNote("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyNote(
        "Copy the whole address from the browser bar, including the part after the #, and open it in the other browser.",
      );
    }
  }

  function joinFromHere(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = normalizeName(draftName);
    if (!name) return;
    saveName(name);
    void loadOT().then((OT) => OT.unblockAudio());
  }

  function toggleAudio() {
    const next = !audioOn;
    publisher.current?.publishAudio(next);
    setAudioOn(next);
  }

  function toggleVideo() {
    const next = !videoOn;
    publisher.current?.publishVideo(next);
    setVideoOn(next);
  }

  function leave() {
    router.push("/");
  }

  const selfConnectionId = session?.connection?.connectionId;
  const guests = people.filter((person) => person.connectionId !== selfConnectionId);
  const others = guests.length;

  if (storedName === null) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="text-sm tracking-wide text-[#a3aa94]">Opening the room…</p>
      </main>
    );
  }

  if (storedName === "") {
    return (
      <main className="grid min-h-dvh place-items-center px-5">
        <form
          onSubmit={joinFromHere}
          className="w-full max-w-md rounded-3xl border border-white/10 bg-[#1c2116] p-6"
        >
          <p className="font-display text-3xl tracking-tight">Join {room}</p>
          <p className="mt-2 text-sm leading-6 text-[#a3aa94]">
            This browser will enter the same room. Video and audio are encrypted here
            before Vonage carries them, and decrypted in the other browser before playback.
            The key stays in the link after the # and is not sent to the server.
          </p>
          <label className="mt-5 block text-sm text-[#a3aa94]" htmlFor="join-name">
            Your name
          </label>
          <input
            id="join-name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            autoFocus
            maxLength={32}
            className="mt-2 w-full rounded-2xl border border-white/10 bg-[#12140e] px-4 py-3 outline-none ring-[#d6f25c] focus:ring-2"
          />
          <button
            type="submit"
            className="mt-5 w-full rounded-full bg-[#d6f25c] px-5 py-3 font-medium text-[#172000]"
          >
            Join call
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <Link href="/" className="font-display text-xl tracking-tight">
            Booth
          </Link>
          <p className="truncate font-mono text-sm text-[#a3aa94]">{room}</p>
          <p className="text-xs text-[#d6f25c]">Encrypted in this browser before Vonage</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-[#a3aa94] sm:inline">
            {status === "live"
              ? `${others + 1} in the room`
              : status === "error"
                ? "Not connected"
                : "Connecting"}
          </span>
          <button
            type="button"
            onClick={() => setShowCipherLog((value) => !value)}
            aria-pressed={showCipherLog}
            className="rounded-full border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
          >
            {showCipherLog ? "Hide cipher flow" : "Cipher flow"}
          </button>
          <button
            type="button"
            onClick={() => void copyLink()}
            className="rounded-full border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
          >
            {copied ? "Link copied" : "Copy room link"}
          </button>
        </div>
        {copyNote ? (
          <p className="basis-full text-sm text-[#ffb4a8]">{copyNote}</p>
        ) : null}
        {keyMismatch ? (
          <p className="basis-full rounded-2xl border border-[#ffb4a8]/40 bg-[#ffb4a8]/10 px-4 py-3 text-sm leading-6 text-[#ffb4a8]">
            Someone joined with a different key, so their camera and microphone cannot be
            unsealed here. Use <strong className="font-medium">Copy room link</strong> and have
            them open that exact address — the part after the <code>#</code> carries the key.
          </p>
        ) : null}
      </header>

      <section className="relative mx-4 mb-4 flex min-h-0 flex-1 sm:mx-6">
        <div className="relative min-h-[70dvh] w-full flex-1 overflow-hidden rounded-[1.75rem] bg-[#0c0e0a]">
          {session && streams.length > 0 ? (
            <div
              className={
                streams.length > 1
                  ? "grid h-full grid-cols-1 gap-3 p-3 sm:grid-cols-2"
                  : "h-full"
              }
            >
              {streams.map((stream) => (
                <RemoteTile
                  key={stream.streamId}
                  session={session}
                  stream={stream}
                  onAudioBlocked={reportAudioBlocked}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <p className="font-display text-4xl tracking-tight sm:text-5xl">
                {status === "error"
                  ? "The room did not open."
                  : status === "connecting"
                    ? "Connecting you to the room."
                    : keyMismatch
                      ? "Their video cannot be unsealed."
                      : "Waiting for the other browser."}
              </p>
              <p className="mt-4 max-w-md text-base leading-7 text-[#c9cdb8]">
                {status === "error"
                  ? error
                  : status === "connecting"
                    ? "This browser is getting a token for the Vonage session."
                    : others > 0
                      ? `${guests[0]?.name ?? "Someone"} is here. Their camera has not started yet.`
                      : "Copy this room link and open it in a second browser. Enter a name there and you will see each other."}
              </p>
              {status !== "error" ? (
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="mt-6 rounded-full bg-[#d6f25c] px-5 py-3 font-medium text-[#172000]"
                >
                  {copied ? "Link copied" : "Copy room link"}
                </button>
              ) : (
                <Link href="/" className="mt-6 text-[#d6f25c]">
                  Back to the start
                </Link>
              )}
              {mediaNote ? <p className="mt-4 max-w-md text-sm text-[#ffb4a8]">{mediaNote}</p> : null}
            </div>
          )}

          {showCipherLog ? <CipherPanel onClose={() => setShowCipherLog(false)} /> : null}

          <div className="absolute right-4 bottom-24 z-10 h-36 w-24 overflow-hidden rounded-2xl border border-white/20 bg-black shadow-2xl sm:right-6 sm:h-48 sm:w-32">
              <div ref={publisherNode} className="ot-slot absolute inset-0" />
              {!videoOn ? (
                <div className="absolute inset-0 grid place-items-center bg-[#1c2116] px-2 text-center text-xs text-[#a3aa94]">
                  Camera off
                </div>
              ) : null}
              <p className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-center text-xs">
                {storedName}
              </p>
            </div>
        </div>
      </section>

      {hearPrompt && streams.length > 0 ? (
        <div className="px-4 pb-2 sm:px-6">
          <button
            type="button"
            onClick={() => {
              void loadOT().then((OT) => OT.unblockAudio());
              setHearPrompt(false);
            }}
            className="w-full rounded-2xl bg-[#d6f25c] px-4 py-3 text-sm font-medium text-[#172000]"
          >
            Click to hear the other person
          </button>
        </div>
      ) : null}

      {mediaNote && streams.length > 0 ? (
        <p className="px-6 pb-3 text-center text-sm text-[#ffb4a8]">{mediaNote}</p>
      ) : null}

      <footer className="flex items-center justify-center gap-3 px-4 pb-6">
        <Control
          label={audioOn ? "Mute microphone" : "Unmute microphone"}
          pressed={!audioOn}
          disabled={!readyToPublish}
          onClick={toggleAudio}
        >
          {audioOn ? "Mic on" : "Mic off"}
        </Control>
        <Control
          label={videoOn ? "Turn camera off" : "Turn camera on"}
          pressed={!videoOn}
          disabled={!readyToPublish}
          onClick={toggleVideo}
        >
          {videoOn ? "Camera on" : "Camera off"}
        </Control>
        <button
          type="button"
          onClick={leave}
          className="rounded-full bg-[#ff5a3c] px-5 py-3 text-sm font-medium text-white"
        >
          Leave
        </button>
      </footer>
    </main>
  );
}

function RemoteTile({
  session,
  stream,
  onAudioBlocked,
}: {
  session: Session;
  stream: Stream;
  onAudioBlocked: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = node.current;
    if (!target) return;
    const subscriber = session.subscribe(stream, target, {
      insertMode: "append",
      width: "100%",
      height: "100%",
      fitMode: "cover",
      showControls: false,
    });
    subscriber.on("audioBlocked", onAudioBlocked);
    return () => {
      session.unsubscribe(subscriber);
    };
  }, [onAudioBlocked, session, stream]);

  return (
    <div className="relative h-full min-h-72 overflow-hidden bg-black">
      <div ref={node} className="ot-slot absolute inset-0" />
      <p className="absolute bottom-4 left-4 rounded-full bg-black/55 px-3 py-1 text-sm">
        {stream.name || "Guest"}
      </p>
    </div>
  );
}

function Control({
  children,
  label,
  pressed,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border border-white/15 px-4 py-3 text-sm enabled:hover:bg-white/5 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
