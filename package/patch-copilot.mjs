#!/usr/bin/env node
/**
 * Patches GitHub Copilot login (earendil-works/pi issue #7428): the login flow
 * bulk-POSTed /models/{id}/policy for every known model concurrently, which
 * GitHub rate-limited (429 Too Many Requests), failing login. The POST is
 * removed; models with no policy or an "enabled" policy are usable as-is.
 * Fails loudly if the expected source block changed upstream, so a pi version
 * bump surfaces here instead of silently shipping the bug.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const copilotCandidates = [
  path.join(packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "oauth", "github-copilot.js"),
  // npm nests pi-ai inside pi-coding-agent instead of hoisting it:
  path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "oauth", "github-copilot.js"),
];

const MARKER = `    interaction.notify({ type: "progress", message: "Enabling models..." });
    await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined, interaction.signal);
    return {
        ...credentials,
        availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain ?? undefined, interaction.signal),
    };`;

const REPLACEMENT = `    // Patched by pi-coding-agent-flake: skip bulk policy POST (issue #7428).
    // POSTing /models/{id}/policy for all models on login triggers GitHub's
    // 429 rate limit. Models with no policy or an "enabled" policy work as-is.
    return {
        ...credentials,
        availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain ?? undefined, interaction.signal),
    };`;

const copilotPath = copilotCandidates.find((candidate) => {
  try {
    return readFileSync(candidate, "utf-8").includes(MARKER);
  } catch {
    return false;
  }
});
if (!copilotPath) {
  console.error(`patch-copilot.mjs: copilot login marker not found in any of:\n  ${copilotCandidates.join("\n  ")}`);
  console.error("Upstream github-copilot.js changed — update the MARKER in package/patch-copilot.mjs.");
  process.exit(1);
}
const source = readFileSync(copilotPath, "utf-8");
writeFileSync(copilotPath, source.replace(MARKER, REPLACEMENT));
console.log(`patch-copilot.mjs: patched ${copilotPath}`);