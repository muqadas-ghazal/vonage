import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isValidRoom, normalizeName, normalizeRoom } from "./room-name";

type StoredSession = { sessionId: string; mode: "relayed" };
type SessionStore = Record<string, StoredSession | string>;

const dataDir = path.join(process.cwd(), "data");
const storePath = path.join(dataDir, "sessions.json");
const videoHost = "https://api.opentok.com";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function envValue(...names: string[]): string {
  for (const name of names) {
    const raw = process.env[name]?.trim() ?? "";
    if (!raw) continue;
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1).trim();
    }
    return raw;
  }
  return "";
}

function projectCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = envValue("PROJECT_API_KEY", "VONAGE_API_KEY");
  const apiSecret = envValue("PROJECT_SECRET", "VONAGE_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error(
      "Add PROJECT_API_KEY and PROJECT_SECRET to .env. These are the project API key and project secret from the Vonage dashboard.",
    );
  }
  return { apiKey, apiSecret };
}

/**
 * Serverless hosts give each instance its own read-only filesystem, so the file store
 * cannot keep two people in one room. Say so at startup rather than at the first join.
 */
function storageProblem(): string | null {
  if (usingSharedStore()) return null;
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (!serverless) return null;
  return (
    "Rooms are stored on disk, which does not work on this host: the filesystem is " +
    "read-only and every instance has its own. Add a Vercel KV or Upstash Redis " +
    "integration, then set KV_REST_API_URL and KV_REST_API_TOKEN."
  );
}

export function credentialProblem(): string | null {
  const storage = storageProblem();
  if (storage) return storage;
  try {
    projectCredentials();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The Vonage project API key or secret is missing.";
  }
}

function signProjectJwt(apiSecret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function projectClaims(apiKey: string, ttlSeconds: number, extra: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    iss: apiKey,
    ist: "project",
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: crypto.randomUUID(),
    ...extra,
  };
}

function clientToken(
  apiKey: string,
  apiSecret: string,
  sessionId: string,
  name: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    `session_id=${sessionId}`,
    `create_time=${now}`,
    `expire_time=${now + 60 * 60 * 24}`,
    `nonce=${crypto.randomInt(0, 2_147_483_647)}`,
    "role=publisher",
    `connection_data=${`name=${encodeURIComponent(name)}`}`,
  ].join("&");
  const signature = crypto.createHmac("sha1", apiSecret).update(data).digest("hex");
  const decoded = `partner_id=${apiKey}&sig=${signature}:${data}`;
  return `T1==${Buffer.from(decoded).toString("base64")}`;
}

/* ── Where room → session mappings live ──────────────────────────────────────────
 *
 * Both browsers in a room must join the SAME Vonage session, so the mapping has to be
 * shared by every server that handles a join. A JSON file works on one machine and fails
 * on serverless hosting twice over: the filesystem is read-only, and each instance would
 * have its own copy anyway, so two people in one room would land in different sessions.
 *
 * So: a Redis-compatible KV over its REST API when one is configured (Vercel KV and
 * Upstash both provide these variables), and the file otherwise for local development.
 * No new dependency — it is one fetch.
 */

const kvUrl = envValue("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
const kvToken = envValue("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");

export function usingSharedStore(): boolean {
  return Boolean(kvUrl && kvToken);
}

async function kv(command: unknown[]): Promise<unknown> {
  const response = await fetch(kvUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The room store rejected a request (${response.status}).`);
  }
  const body = (await response.json()) as { result?: unknown };
  return body.result ?? null;
}

/**
 * Claims `room` for `sessionId`, returning whichever session id actually won.
 * SET NX makes two people creating the same room at once converge on one session
 * instead of silently ending up in separate calls.
 */
async function claimRoom(room: string, sessionId: string): Promise<string> {
  const key = `booth:room:${room}`;
  const claimed = await kv(["SET", key, sessionId, "NX"]);
  if (claimed) return sessionId;
  const existing = await kv(["GET", key]);
  return typeof existing === "string" && existing ? existing : sessionId;
}

async function lookupRoom(room: string): Promise<string | null> {
  const existing = await kv(["GET", `booth:room:${room}`]);
  return typeof existing === "string" && existing ? existing : null;
}

function readStore(): SessionStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as SessionStore;
  } catch {
    return {};
  }
}

function writeStore(store: SessionStore) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${storePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, storePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new Error(
        "This host has a read-only filesystem, so rooms cannot be stored on disk. " +
          "Add a Vercel KV or Upstash Redis integration and set KV_REST_API_URL and " +
          "KV_REST_API_TOKEN, otherwise two people in the same room join different calls.",
      );
    }
    throw error;
  }
}

async function createSession(apiKey: string, apiSecret: string): Promise<string> {
  const response = await fetch(`${videoHost}/session/create`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-OPENTOK-AUTH": signProjectJwt(apiSecret, projectClaims(apiKey, 180)),
    },
    body: "p2p.preference=enabled",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Vonage rejected the project credentials (${response.status}). Check PROJECT_API_KEY and PROJECT_SECRET in .env, then restart the dev server.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Vonage did not return a session.");
  }

  const sessionId = Array.isArray(payload)
    ? payload[0]?.session_id
    : payload && typeof payload === "object" && "session_id" in payload
      ? payload.session_id
      : undefined;

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Vonage did not return a session.");
  }
  return sessionId;
}

function storedSessionId(value: StoredSession | string | undefined): string | null {
  if (!value || typeof value === "string") return null;
  if (value.mode !== "relayed" || !value.sessionId) return null;
  return value.sessionId;
}

async function sessionForRoom(room: string, apiKey: string, apiSecret: string): Promise<string> {
  if (usingSharedStore()) {
    const existing = await lookupRoom(room);
    if (existing) return existing;
    const sessionId = await createSession(apiKey, apiSecret);
    return claimRoom(room, sessionId);
  }

  const existing = storedSessionId(readStore()[room]);
  if (existing) return existing;

  const sessionId = await createSession(apiKey, apiSecret);
  const store = readStore();
  store[room] = { sessionId, mode: "relayed" };
  writeStore(store);
  return sessionId;
}

export async function joinRoom(roomInput: string, nameInput: string) {
  const room = normalizeRoom(roomInput);
  const name = normalizeName(nameInput);

  if (!isValidRoom(room)) {
    throw new Error("Use a room name with 3–40 letters, numbers, or hyphens.");
  }
  if (name.length < 1) {
    throw new Error("Enter your name before joining.");
  }

  const { apiKey, apiSecret } = projectCredentials();
  const sessionId = await enqueue(() => sessionForRoom(room, apiKey, apiSecret));

  return {
    apiKey,
    sessionId,
    token: clientToken(apiKey, apiSecret, sessionId, name),
    room,
  };
}

export function publicError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 400);
  }
  return "Vonage could not start this room.";
}
