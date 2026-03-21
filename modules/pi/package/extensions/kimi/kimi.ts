import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

function readAuthFile(): Record<string, unknown> {
  try {
    if (!fs.existsSync(AUTH_FILE)) return {};
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeAuthFile(auth: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("kimi-login", {
    description: "Set Kimi API key (stored as api_key type)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.error("kimi-login requires UI mode");
        return;
      }

      const apiKey = await ctx.ui.input(
        "Enter your Kimi Code API Key (starts with sk-kimi-):",
        "sk-kimi-..."
      );

      if (!apiKey) {
        ctx.ui.notify("Login cancelled", "info");
        return;
      }

      const auth = readAuthFile();
      auth["kimi-coding"] = {
        type: "api_key",
        key: apiKey
      };

      if (writeAuthFile(auth)) {
        ctx.ui.notify("Kimi API key saved successfully", "info");
      } else {
        ctx.ui.notify("Failed to save API key", "error");
      }
    }
  });
}
