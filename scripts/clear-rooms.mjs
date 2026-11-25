// Clears the room store, so the next "Create a room" starts from nothing.
//
//   node --env-file=.env scripts/clear-rooms.mjs --dry-run
//   node --env-file=.env scripts/clear-rooms.mjs
//
// Two things hold rooms: `booth:lobby` (what the app's lobby screen lists) and one
// `booth:room:<name>` key per room (the room -> Vonage session mapping). Clearing only
// the lobby would hide rooms while still rejoining old sessions, so both go.
//
// Pass --lobby to empty only the listing and keep the mappings.
import fs from "node:fs";
import path from "node:path";

const dryRun = process.argv.includes("--dry-run");
const lobbyOnly = process.argv.includes("--lobby");

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

async function redis(command) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Redis rejected ${command[0]} (${response.status}).`);
  return (await response.json()).result ?? null;
}

async function clearShared() {
  const lobby = (await redis(["HKEYS", "booth:lobby"])) ?? [];
  console.log(`  booth:lobby            ${lobby.length} room(s) listed`);

  // SCAN rather than KEYS: KEYS blocks the server, and a cursor loop is correct even
  // when the keyspace grows past one page.
  const keys = [];
  let cursor = "0";
  do {
    const [next, page] = await redis(["SCAN", cursor, "MATCH", "booth:room:*", "COUNT", "500"]);
    cursor = String(next);
    keys.push(...(page ?? []));
  } while (cursor !== "0");
  console.log(`  booth:room:*           ${keys.length} session mapping(s)`);

  if (dryRun) return;

  if (lobby.length > 0) await redis(["DEL", "booth:lobby"]);
  if (!lobbyOnly && keys.length > 0) {
    // Chunked: one DEL with thousands of arguments can exceed the request limit.
    for (let index = 0; index < keys.length; index += 200) {
      await redis(["DEL", ...keys.slice(index, index + 200)]);
    }
  }
  console.log(lobbyOnly ? "  cleared the lobby listing" : "  cleared the lobby and every session mapping");
}

function clearFile() {
  const file = path.resolve("data/sessions.json");
  if (!fs.existsSync(file)) {
    console.log("  data/sessions.json     absent");
    return;
  }
  const count = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length;
  console.log(`  data/sessions.json     ${count} room(s)`);
  if (dryRun) return;
  fs.writeFileSync(file, "{}\n");
  console.log("  emptied data/sessions.json");
}

const shared = Boolean(url && token);
console.log(`store: ${shared ? "Upstash/KV (active)" : "local file"}${dryRun ? "  [dry run]" : ""}`);

if (shared) await clearShared();
clearFile();

if (dryRun) console.log("\nNothing was changed. Re-run without --dry-run to clear.");
