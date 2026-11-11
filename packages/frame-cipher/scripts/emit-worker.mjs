// Writes the worker out as a standalone file for consumers whose CSP forbids blob: workers.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { WORKER_SOURCE } = await import(join(root, "dist", "worker-source.js"));
const out = join(root, "dist", "frame-cipher.worker.js");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `/* @booth/frame-cipher — generated from src/worker-source.ts, do not edit */\n${WORKER_SOURCE}`);
console.log(`wrote ${out} (${WORKER_SOURCE.length} bytes)`);
