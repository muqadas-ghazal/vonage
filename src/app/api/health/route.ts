import { credentialProblem } from "@/lib/vonage";

export async function GET() {
  const message = credentialProblem();
  if (message) {
    return Response.json({ ready: false, message });
  }
  return Response.json({ ready: true });
}
