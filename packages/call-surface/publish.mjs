// Copies the built surface into the Next.js app's public/ directory.
//
// Served from the backend's own origin, which means https for free, no CORS, and no
// file:// secure-context question. The app points its WebView at /surface/index.html.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const from = path.resolve(import.meta.dirname, "dist/index.html");
const toDir = path.resolve(import.meta.dirname, "../../public/surface");
await mkdir(toDir, { recursive: true });
await copyFile(from, path.join(toDir, "index.html"));
console.log("published → public/surface/index.html");
