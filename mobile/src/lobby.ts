/** Talking to the Next.js backend. It is the only server the app knows about. */

export type OpenRoom = { room: string; lastSeen: number };

export function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
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
