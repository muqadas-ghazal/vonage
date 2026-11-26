/** Talking to the Next.js backend. It is the only server the app knows about. */

export type OpenRoom = { room: string; lastSeen: number };

export function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const ADJECTIVES = ["amber", "quiet", "cedar", "bright", "linen", "moss", "silver", "calm"];
const NOUNS = ["harbor", "studio", "garden", "porch", "bridge", "attic", "window", "meadow"];

/** Same shape as the web lobby: two words, already valid as a room name. */
export function suggestRoom(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? "amber";
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? "harbor";
  return `${adjective}-${noun}`;
}

export function normalizeRoom(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function isValidRoom(room: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(room);
}

export function normalizeName(input: string): string {
  return input.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 32);
}

/**
 * A typed room name, or a pasted room link (`https://host/call/amber-harbor`).
 * The link is what the other person opens. The app only needs the room at the end.
 */
export function roomFromInput(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/call\/([^/]+)/);
    if (match?.[1]) return normalizeRoom(decodeURIComponent(match[1]));
  } catch {
    // A plain room name is not a URL.
  }
  return normalizeRoom(trimmed);
}

export function roomLink(apiBase: string, room: string): string {
  return `${normalizeBase(apiBase)}/call/${room}`;
}

/** A fresh room name that satisfies the backend's 3–40 letters/numbers/hyphens rule. */
export function newRoomName(): string {
  // No look-alike characters: these get read aloud during testing.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `room-${suffix}`;
}

export async function fetchOpenRooms(apiBase: string, signal?: AbortSignal): Promise<OpenRoom[]> {
  const response = await fetch(`${normalizeBase(apiBase)}/api/rooms`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`The server returned ${response.status}.`);
  const payload = (await response.json()) as { rooms?: OpenRoom[]; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.rooms ?? [];
}

/**
 * Keeps a room listed in the lobby while we are in it.
 *
 * Without this the room ages out after two minutes and the other device would watch it
 * disappear mid-call. Deliberately not a join: joining would mint a new token each beat.
 */
export async function heartbeat(apiBase: string, room: string): Promise<void> {
  await fetch(`${normalizeBase(apiBase)}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room, touch: true }),
  });
}
