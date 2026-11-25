// Builds the call surface into a single self-contained index.html.
//
// Everything is inlined — script, styles, the inlined cipher worker — because the output
// is bundled into a mobile app and served from a local origin with no asset pipeline in
// front of it. One file means nothing can 404 at runtime.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const out = path.resolve(import.meta.dirname, "dist");
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [path.resolve(import.meta.dirname, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: ["safari15.4", "chrome141"],
  minify: true,
  sourcemap: false,
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

const script = result.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Call</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #grid {
    display: grid; gap: 2px; height: 100%; width: 100%;
    grid-template-columns: 1fr;
  }
  #grid[data-count="2"] { grid-template-rows: 1fr 1fr; }
  #grid[data-count="3"], #grid[data-count="4"] {
    grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
  }
  .tile { position: relative; background: #0b0f0d; overflow: hidden; }
  .tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* A locked tile is deliberately blank, not scrambled: frames are dropped before the
     decoder, so there is nothing to paint. */
  .tile[data-state="locked"] video { visibility: hidden; }
  .tile[data-state="locked"]::after {
    content: "Locked"; position: absolute; inset: 0; display: grid; place-items: center;
    color: #d2544a; font: 600 14px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em;
  }
  #status {
    position: absolute; left: 0; right: 0; top: 0; padding: 10px 14px;
    color: #8d9a92; background: rgba(11,15,13,.82); text-align: center;
    font: 400 12px/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  #status[data-done="1"] { display: none; }
  #fatal {
    position: absolute; inset: 0; display: none; place-items: center; padding: 24px;
    color: #e6ece8; background: #0b0f0d; text-align: center;
    font: 400 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  }
  #fatal[data-show="1"] { display: grid; }
</style>
</head>
<body>
<div id="grid" data-count="0"></div>
<div id="status">Starting…</div>
<div id="fatal"></div>
<script>${script}</script>
</body>
</html>
`;

await writeFile(path.join(out, "index.html"), html, "utf8");
console.log(`index.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
