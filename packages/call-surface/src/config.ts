/**
 * Where the call surface gets its instructions.
 *
 * The React Native shell injects `window.__callConfig` before any script runs, so it is
 * already present by the time this module loads. The URL-hash fallback exists so the same
 * build can be opened in a desktop browser for debugging, which is how you compare a phone
 * against a console.
 */
export type CallConfig = {
  /** Origin of the Next.js backend that mints Vonage credentials. No trailing slash. */
  apiBase: string;
  room: string;
  name: string;
};

declare global {
  interface Window {
    __callConfig?: Partial<CallConfig>;
  }
}

export function readConfig(): CallConfig {
  const injected = window.__callConfig ?? {};
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));

  const apiBase = (injected.apiBase ?? hash.get("apiBase") ?? location.origin).replace(/\/$/, "");
  const room = injected.room ?? hash.get("room") ?? "";
  const name = injected.name ?? hash.get("name") ?? "Guest";

  if (!room) throw new Error("No room was given to the call surface.");
  return { apiBase, room, name };
}

export type Credentials = {
  apiKey: string;
  sessionId: string;
  token: string;
  room: string;
};

/**
 * Asks the backend for a session and a token.
 *
 * This is the one thing that cannot be bundled into the app: minting a token needs
 * PROJECT_SECRET, and a secret shipped inside an APK is not a secret.
 */
export async function join(config: CallConfig): Promise<Credentials> {
  const response = await fetch(`${config.apiBase}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: config.room, name: config.name }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (Credentials & { error?: string })
    | null;

  if (!response.ok || !payload || payload.error) {
    throw new Error(payload?.error ?? `The server refused the join (${response.status}).`);
  }
  return payload;
}
