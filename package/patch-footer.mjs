#!/usr/bin/env node
/**
 * Patches pi's TUI footer in both source copies:
 *   - dist/modes/interactive/components/footer.js (unbundled copy)
 *   - dist/bundle/chunks/*.js (bundled copy — the one the CLI entrypoint
 *     dist/bundle/cli.js actually executes since aa47207)
 *
 * Patched behavior:
 *   1. Stats line shows only context usage. Token counts (↑↓ R W CH), cost,
 *      and the xp badge are dropped; the model name stays right-aligned.
 *   2. First line shows the cwd basename with extension statuses
 *      (ctx.ui.setStatus) right-aligned instead of on a separate line.
 *
 * The bundled markers are authoritative: the build fails loudly if they
 * change upstream. A missing unbundled marker only warns (that copy is not
 * executed). patch-alt-scroll.mjs follows the same bundle-first rule.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const distRoot = path.join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
);
const footerPath = path.join(distRoot, "modes", "interactive", "components", "footer.js");
const chunksDir = path.join(distRoot, "bundle", "chunks");

// --- Unbundled (dist/modes) markers -----------------------------------------

const STATS_MARKER = `        let statsLeft = statsParts.join(" ");`;
const STATS_REPLACEMENT = `        let statsLeft = contextPercentStr;`;

const PWD_MARKER = `        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
        const lines = [pwdLine, dimStatsLeft + dimRemainder];
        // Add extension statuses on a single line, sorted by key alphabetically
        const extensionStatuses = this.footerData.getExtensionStatuses();
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            // Truncate to terminal width with dim ellipsis for consistency with footer style
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        return lines;`;

const PWD_REPLACEMENT = `        // Patched by pi-coding-agent-flake: statuses render right-aligned on the pwd line.
        const pwdLine = (() => {
            const trimmedPwd = pwd.replace(/[\\/]+$/, "");
            const shortPwd = trimmedPwd.split(/[\\/]/).at(-1) || pwd;
            const pwdStyled = theme.fg("dim", shortPwd);
            const extensionStatuses = this.footerData.getExtensionStatuses();
            if (extensionStatuses.size === 0) {
                return truncateToWidth(pwdStyled, width, theme.fg("dim", "..."));
            }
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusText = truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "..."));
            const statusTextWidth = visibleWidth(statusText);
            const availablePwdWidth = width - statusTextWidth - 2;
            if (availablePwdWidth < 10) {
                return statusText;
            }
            const pwdTruncated = truncateToWidth(pwdStyled, availablePwdWidth, theme.fg("dim", "..."));
            const gap = Math.max(2, width - visibleWidth(pwdTruncated) - statusTextWidth);
            return pwdTruncated + " ".repeat(gap) + statusText;
        })();
        return [pwdLine, dimStatsLeft + dimRemainder];`;

// --- Bundled (dist/bundle/chunks) markers -----------------------------------

const BUNDLED_STATS_MARKER = `let statsLeft=statsParts.join(" ")`;
const BUNDLED_STATS_REPLACEMENT = `let statsLeft=contextPercentStr`;

const BUNDLED_PWD_MARKER = `lines=[truncateToWidth(theme.fg("dim",pwd),width,theme.fg("dim","...")),dimStatsLeft+dimRemainder],extensionStatuses=this.footerData.getExtensionStatuses();if(extensionStatuses.size>0){let statusLine=Array.from(extensionStatuses.entries()).sort(([a],[b2])=>a.localeCompare(b2)).map(([,text])=>sanitizeStatusText(text)).join(" ");lines.push(truncateToWidth(statusLine,width,theme.fg("dim","...")))}`;

const BUNDLED_PWD_REPLACEMENT = `extensionStatuses=this.footerData.getExtensionStatuses(),pwdLine=(()=>{let shortPwd=pwd.replace(/[\\/]+$/,"").split("/").at(-1)||pwd,pwdStyled=theme.fg("dim",shortPwd);if(extensionStatuses.size===0)return truncateToWidth(pwdStyled,width,theme.fg("dim","..."));let statusText=truncateToWidth(Array.from(extensionStatuses.entries()).sort(([a],[b2])=>a.localeCompare(b2)).map(([,text])=>sanitizeStatusText(text)).join(" "),width,theme.fg("dim","...")),statusTextWidth=visibleWidth(statusText),availablePwdWidth=width-statusTextWidth-2;if(availablePwdWidth<10)return statusText;let pwdTruncated=truncateToWidth(pwdStyled,availablePwdWidth,theme.fg("dim","...")),gap=Math.max(2,width-visibleWidth(pwdTruncated)-statusTextWidth);return pwdTruncated+" ".repeat(gap)+statusText})(),lines=[pwdLine,dimStatsLeft+dimRemainder];`;

const PATCHES = [
  { name: "stats line (context usage only)", unbundled: [STATS_MARKER, STATS_REPLACEMENT], bundled: [BUNDLED_STATS_MARKER, BUNDLED_STATS_REPLACEMENT] },
  { name: "pwd basename + right-aligned statuses", unbundled: [PWD_MARKER, PWD_REPLACEMENT], bundled: [BUNDLED_PWD_MARKER, BUNDLED_PWD_REPLACEMENT] },
];

// --- Apply ------------------------------------------------------------------

const files = [];
if (existsSync(footerPath)) files.push({ path: footerPath, bundled: false });
if (!existsSync(chunksDir)) {
  console.error(`patch-footer.mjs: chunks dir not found: ${chunksDir}`);
  process.exit(1);
}
for (const file of readdirSync(chunksDir).filter((f) => f.endsWith(".js"))) {
  files.push({ path: path.join(chunksDir, file), bundled: true });
}

const sources = new Map(files.map((f) => [f.path, readFileSync(f.path, "utf-8")]));
let failed = false;

for (const patch of PATCHES) {
  for (const bundled of [false, true]) {
    const [marker, replacement] = patch[bundled ? "bundled" : "unbundled"];
    const hits = files.filter(
      (f) => f.bundled === bundled && sources.get(f.path).includes(marker),
    );
    if (hits.length === 0) {
      const label = `${patch.name} (${bundled ? "bundle" : "unbundled"})`;
      if (bundled) {
        console.error(`patch-footer.mjs: marker not found: ${label}`);
        console.error(`Marker: ${marker.slice(0, 120)}...`);
        failed = true;
      } else {
        console.warn(`patch-footer.mjs: warning, marker not found (skipped): ${label}`);
      }
      continue;
    }
    for (const f of hits) {
      sources.set(f.path, sources.get(f.path).replace(marker, replacement));
      console.log(`patch-footer.mjs: patched ${patch.name} in ${path.relative(packageRoot, f.path)}`);
    }
  }
}

if (failed) {
  console.error("Upstream bundle changed — update the markers in package/patch-footer.mjs.");
  process.exit(1);
}

for (const [filePath, source] of sources) {
  writeFileSync(filePath, source);
}
