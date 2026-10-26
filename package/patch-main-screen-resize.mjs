#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rex forwards Android keyboard resizes to a macOS PTY, where TERMUX_VERSION is absent.
const resizeCondition = /heightChanged\s*&&\s*!isTermuxSession\(\)/g;
const replacement = 'heightChanged&&!isTermuxSession()&&process.env.PI_TUI_INCREMENTAL_HEIGHT_RESIZE!=="1"';

export function patchMainScreenResize(source, label) {
  const matches = [...source.matchAll(resizeCondition)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one main-screen height-resize condition, found ${matches.length}`);
  }
  if (source.includes("PI_TUI_INCREMENTAL_HEIGHT_RESIZE")) {
    throw new Error(`${label}: main-screen height-resize policy is already patched`);
  }
  return source.replace(resizeCondition, replacement);
}

export function patchPackage(packageRoot) {
  const namespaceRoot = path.join(packageRoot, "node_modules", "@earendil-works");
  const chunksDirectory = path.join(namespaceRoot, "pi-coding-agent", "dist", "bundle", "chunks");
  const bundledFiles = readdirSync(chunksDirectory)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(chunksDirectory, name))
    .filter((file) => /heightChanged\s*&&\s*!isTermuxSession\(\)/.test(readFileSync(file, "utf8")));
  if (bundledFiles.length !== 1) {
    throw new Error(`Expected one bundled main-screen renderer, found ${bundledFiles.length}`);
  }
  const files = [
    ...bundledFiles,
    path.join(namespaceRoot, "pi-tui", "dist", "tui-main-screen.js"),
  ];
  // Validate both copies before changing either, so upstream drift fails the package build.
  const patches = files.map((file) => [file, patchMainScreenResize(readFileSync(file, "utf8"), file)]);
  for (const [file, source] of patches) {
    writeFileSync(file, source);
    console.log(`patch-main-screen-resize.mjs: patched ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchPackage(path.dirname(fileURLToPath(import.meta.url)));
}
