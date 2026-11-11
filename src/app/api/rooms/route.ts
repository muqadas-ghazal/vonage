import { joinRoom, publicError } from "@/lib/vonage";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a room name and your name." }, { status: 400 });
  }

  const room =
    body && typeof body === "object" && "room" in body ? String(body.room) : "";
  const name =
    body && typeof body === "object" && "name" in body ? String(body.name) : "";

  try {
    const credentials = await joinRoom(room, name);
    return Response.json(credentials);
  } catch (error) {
    console.error("Failed to join room", error);
    const message = publicError(error);
    const missingCredentials =
      message.includes("PROJECT_API_KEY") || message.includes("PROJECT_SECRET");
    const status = missingCredentials ? 503 : message.includes("room name") || message.includes("your name") ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}
