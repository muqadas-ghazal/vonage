import { joinRoom, listOpenRooms, publicError, touchRoom } from "@/lib/vonage";

/**
 * Origins allowed to mint credentials cross-origin.
 *
 * The mobile app serves the bundled call surface from a loopback origin whose port is
 * chosen at runtime, so the port cannot be pinned — only the host. Anything else must be
 * listed explicitly in CALL_SURFACE_ORIGINS.
 *
 * Note what this is and is not: this endpoint has no authentication, so CORS is the only
 * thing currently stopping an arbitrary website from reading a token out of it. Keep the
 * list tight, and authenticate the endpoint before this ships.
 */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;

  const configured = (process.env.CALL_SURFACE_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return origin;

  try {
    const url = new URL(origin);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) return origin;
  } catch {
    // A malformed Origin header is not an origin we allow.
  }
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = allowedOrigin(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    // Responses differ by Origin, so caches must not serve one origin's response to another.
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

/**
 * The open rooms, so a second device can discover one without typing its name.
 *
 * Polled by the app's lobby screen. Deliberately a plain GET rather than a stream: a
 * two-second poll is simpler than SSE, survives serverless timeouts, and reconnects for
 * free when a phone comes back from the background.
 */
export async function GET(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));
  try {
    return Response.json({ rooms: await listOpenRooms() }, { headers: { ...cors, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to list rooms", error);
    return Response.json({ error: publicError(error) }, { status: 502, headers: cors });
  }
}

export async function POST(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a room name and your name." }, { status: 400, headers: cors });
  }

  const room = body && typeof body === "object" && "room" in body ? String(body.room) : "";
  const name = body && typeof body === "object" && "name" in body ? String(body.name) : "";
  const touch = Boolean(body && typeof body === "object" && "touch" in body && body.touch);

  // A heartbeat from a client already in the call. Keeps the room listed without minting
  // another token, which joining would otherwise do on every beat.
  if (touch) {
    try {
      await touchRoom(room);
      return Response.json({ ok: true }, { headers: cors });
    } catch (error) {
      return Response.json({ error: publicError(error) }, { status: 502, headers: cors });
    }
  }

  try {
    const credentials = await joinRoom(room, name);
    return Response.json(credentials, { headers: cors });
  } catch (error) {
    console.error("Failed to join room", error);
    const message = publicError(error);
    const missingCredentials =
      message.includes("PROJECT_API_KEY") || message.includes("PROJECT_SECRET");
    const status = missingCredentials
      ? 503
      : message.includes("room name") || message.includes("your name")
        ? 400
        : 502;
    return Response.json({ error: message }, { status, headers: cors });
  }
}
