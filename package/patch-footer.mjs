#!/usr/bin/env node
/**
 * Patches the pi-built footer so it shows only the cwd basename and extension
 * statuses (ctx.ui.setStatus) render right-aligned on the first footer line
 * instead of on a separate line below the stats. Fails loudly if the expected
 * source block changed upstream, so a pi version bump surfaces here instead of
 * silently breaking the layout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const footerPath = path.join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "components",
  "footer.js",
);

const MARKER = `        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
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

const REPLACEMENT = `        // Patched by pi-coding-agent-flake: statuses render right-aligned on the pwd line.
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

const source = readFileSync(footerPath, "utf-8");
const filteredSource = source.replace(
  "        let statsLeft = statsParts.join(\" \");",
  `        let statsLeft = statsParts
            .filter((part) => !/^(↑|↓|R|W|CH)/.test(part))
            .join(" ");`,
);
if (!source.includes(MARKER)) {
  console.error(`patch-footer.mjs: footer marker not found in ${footerPath}`);
  console.error("Upstream footer.js changed — update the MARKER in package/patch-footer.mjs.");
  process.exit(1);
}
writeFileSync(footerPath, filteredSource.replace(MARKER, REPLACEMENT));
console.log(`patch-footer.mjs: patched ${footerPath}`);