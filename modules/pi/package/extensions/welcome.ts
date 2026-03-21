import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { TUI } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

function middleTruncate(s: string, maxWidth: number, ellipsis = "…"): string {
  const totalW = visibleWidth(s);
  if (totalW <= maxWidth) return s;

  const ellW = visibleWidth(ellipsis);
  if (maxWidth <= ellW) return truncateToWidth(s, maxWidth, "");

  const keep = maxWidth - ellW;
  const leftW = Math.ceil(keep / 2);
  const rightW = Math.floor(keep / 2);

  const left = truncateToWidth(s, leftW, "");
  const right = extractRightSuffix(s, rightW);

  return left + ellipsis + right;
}

function extractRightSuffix(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  const parts = s.split(/(\x1b\[[0-9;]*m)/).filter(Boolean);
  let collected: string[] = [];
  let widthUsed = 0;

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^\x1b\[/.test(part)) {
      collected.unshift(part);
      continue;
    }

    const partW = visibleWidth(part);
    if (partW <= maxWidth - widthUsed) {
      collected.unshift(part);
      widthUsed += partW;
    } else {
      const need = maxWidth - widthUsed;
      if (need > 0) {
        const suffix = sliceRightPlain(part, need);
        if (suffix) collected.unshift(suffix);
      }
      break;
    }
  }

  return collected.join("");
}

function sliceRightPlain(s: string, cols: number): string {
  const chars = [...s];
  let acc = "";
  let accW = 0;

  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const w = visibleWidth(ch);
    if (accW + w > cols) break;
    acc = ch + acc;
    accW += w;
  }

  return acc;
}

function formatPath(path: string, maxWidth: number): string {
  if (visibleWidth(path) <= maxWidth) return path;

  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return middleTruncate(path, maxWidth);

  const dirname = path.slice(0, lastSlash + 1);
  const basename = path.slice(lastSlash + 1);
  const basenameW = visibleWidth(basename);

  if (basenameW >= maxWidth - 3) {
    return "…" + truncateToWidth(basename, maxWidth - 1, "");
  }

  const dirBudget = maxWidth - basenameW;
  const truncatedDir = middleTruncate(dirname, dirBudget, "…");
  return truncatedDir + basename;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Set up custom header that shows truncated version on resize
    ctx.ui.setHeader((tui: TUI, theme: Theme) =>
      new WelcomeHeaderComponent(theme)
    );

    // Set up a widget that hides when there are messages
    ctx.ui.setWidget(
      "welcome-info",
      (_tui, theme) => new ConditionalWelcomeWidget(theme, ctx),
      { placement: "aboveEditor" }
    );
  });
}

/**
 * Header component for resize handling - shows truncated context info
 */
class WelcomeHeaderComponent implements Component {
  private theme: Theme;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme) {
    this.theme = theme;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const context = getContextInfo();

    if (context.contextFiles.length > 0) {
      lines.push(this.theme.fg("muted", "[Context]"));
      for (const file of context.contextFiles) {
        lines.push(middleTruncate("  " + formatPath(file, width - 2), width));
      }
      lines.push("");
    }

    if (context.skills.length > 0) {
      lines.push(this.theme.fg("muted", "[Skills]"));
      lines.push("  user");
      for (const skill of context.skills) {
        lines.push(middleTruncate("    " + formatPath(skill.path, width - 4), width));
      }
      lines.push("");
    }

    if (context.extensions.length > 0) {
      lines.push(this.theme.fg("muted", "[Extensions]"));
      lines.push("  user");
      for (const ext of context.extensions) {
        lines.push(middleTruncate("    " + formatPath(ext.path, width - 4), width));
      }
      lines.push("");
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Widget that shows welcome info only when there are no messages yet
 */
class ConditionalWelcomeWidget implements Component {
  private theme: Theme;
  private ctx: { sessionManager: { getEntries?: () => unknown[] } };

  constructor(theme: Theme, ctx: { sessionManager: { getEntries?: () => unknown[] } }) {
    this.theme = theme;
    this.ctx = ctx;
  }

  render(width: number): string[] {
    // Hide when there are messages in the conversation
    const entries = this.ctx.sessionManager.getEntries?.() || [];
    if (entries.length > 0) {
      return []; // Return empty to hide
    }

    // Show welcome message (context is already shown in header)
    const welcomeText = "Welcome to pi — your coding assistant. Let's build something great together.";
    return [
      this.theme.fg("accent", middleTruncate(welcomeText, width)),
      "" // spacer
    ];
  }

  invalidate(): void {
    // No cache
  }
}

function getContextInfo() {
  return {
    contextFiles: [
      joinHome(".pi/agent/AGENTS.md"),
      "/private/etc/nix-darwin/AGENTS.md"
    ],
    skills: [
      { scope: "user" as const, path: joinHome(".pi/agent/skills/find-skills/SKILL.md") },
      { scope: "user" as const, path: joinHome(".pi/agent/skills/morphe-patcher/SKILL.md") }
    ],
    extensions: [
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/file-command.ts" },
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/handoff.ts" },
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/kimi/kimi.ts" },
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/lsp/lsp-tool.ts" },
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/lsp/lsp.ts" },
      { scope: "user" as const, path: "/nix/store/jayscj29apwb7b0syl7hwn2b43ki2k30-nixdots-pi-extensions-1.0.0/extensions/pi-notify.ts" },
      { scope: "user" as const, path: joinHome(".pi/agent/extensions/welcome.ts") }
    ]
  };
}

function joinHome(path: string): string {
  const home = process.env.HOME || "~";
  return path.replace(/^~/, home);
}
