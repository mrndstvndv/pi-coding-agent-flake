#!/usr/bin/env node
/**
 * Speeds up fullscreen wheel scrolling (pi-mono v0.85.1 bundle).
 *
 * Upstream defaults in packages/tui/src/tui-alt-screen.ts:
 *   wheelScrollLines = options.wheelScrollLines ?? 1   (plain wheel step)
 *   ALT_WHEEL_SCROLL_MULTIPLIER = 5                     (Alt+wheel multiplier)
 * bundled as:
 *   options.wheelScrollLines??1
 *   ALT_WHEEL_SCROLL_MULTIPLIER=5
 * in dist/bundle/chunks/*.js.
 *
 * Why both: touch gestures / plain mouse wheel carry no Alt modifier, so the
 * multiplier never fires for them — only the base step matters. Raising the
 * base alone would also multiply the Alt speed (base x multiplier), so the
 * multiplier is lowered to keep effective Alt+wheel at ~20 lines/tick:
 *   plain wheel: 4 lines/tick, Alt+wheel: 4x5 = 20 lines/tick.
 *
 * Fails loudly if a marker is missing so a pi version bump surfaces here.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const chunksDir = path.join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "chunks",
);

const PATCHES = [
  { marker: "options.wheelScrollLines??1", replacement: "options.wheelScrollLines??4" },
  { marker: "ALT_WHEEL_SCROLL_MULTIPLIER=5", replacement: "ALT_WHEEL_SCROLL_MULTIPLIER=5" },
];

let entries;
try {
  entries = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
} catch (error) {
  console.error(`patch-alt-scroll.mjs: chunks dir not found: ${chunksDir}`);
  console.error(String(error));
  process.exit(1);
}

const sources = new Map();
for (const file of entries) {
  sources.set(file, readFileSync(path.join(chunksDir, file), "utf-8"));
}

for (const { marker, replacement } of PATCHES) {
  const hits = [...sources.entries()].filter(([, source]) => source.includes(marker));
  if (hits.length === 0) {
    console.error(`patch-alt-scroll.mjs: marker "${marker}" not found in ${chunksDir}/*.js`);
    console.error("Upstream bundle changed — update PATCHES in package/patch-alt-scroll.mjs.");
    process.exit(1);
  }
  for (const [file, source] of hits) {
    sources.set(file, source.replaceAll(marker, replacement));
    console.log(`patch-alt-scroll.mjs: patched ${marker} in ${file}`);
  }
}

for (const [file, source] of sources) {
  writeFileSync(path.join(chunksDir, file), source);
}
