import { connection } from "next/server";
import { credentialProblem } from "@/lib/vonage";

export async function GET() {
  // This answer depends on environment variables, which are not knowable while
  // prerendering. connection() defers it to request time, which is the supported way
  // to do this under cacheComponents (the `dynamic` segment export is rejected there).
  await connection();

  const message = credentialProblem();
  if (message) {
    return Response.json({ ready: false, message });
  }
  return Response.json({ ready: true });
}
