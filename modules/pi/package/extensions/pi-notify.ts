import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import { execSync } from "child_process";

const MAX_MESSAGE_LENGTH = 80;
const NOTIFY_TITLE = "Pi";

function sanitizeOscValue(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/[;\\]/g, " ").trim();
}

function shortenMessage(value: string): string {
  if (value.length <= MAX_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}

function writeToTty(ttyPath: string, data: string): boolean {
  try {
    fs.appendFileSync(ttyPath, data);
    return true;
  } catch {
    return false;
  }
}

function buildOsc(payload: string): string {
  return `\x1b]${payload}\x07`;
}

function buildTmuxPassthrough(payload: string): string {
  // tmux passthrough wrapper: ESC Ptmux; ESC ESC ] ... BEL ESC \
  return `\x1bPtmux;\x1b\x1b]${payload}\x07\x1b\\`;
}

function sendOsc9(ttyPath: string, message: string): boolean {
  return writeToTty(ttyPath, buildOsc(`9;${message}`));
}

function sendOsc777(ttyPath: string, title: string, message: string): boolean {
  return writeToTty(ttyPath, buildOsc(`777;notify;${title};${message}`));
}

function getTmuxClientTtys(): string[] {
  try {
    const output = execSync("tmux list-clients -F '#{client_tty}'", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const uniqueTtys = new Set<string>();
    for (const line of output.split("\n")) {
      const tty = line.trim();
      if (!tty) continue;
      uniqueTtys.add(tty);
    }

    return [...uniqueTtys];
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    const inTmux = Boolean(process.env.TMUX);
    const hasTty = Boolean(process.stdout.isTTY);
    if (!inTmux && !hasTty) return;

    const entries = ctx.sessionManager.getBranch();
    let message = "Task completed";

    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "message") continue;
      if (entry.message.role !== "user") continue;

      const content = entry.message.content;
      if (typeof content === "string") {
        message = content;
        break;
      }

      if (!Array.isArray(content)) break;
      const textPart = content.find((part) => part.type === "text");
      if (textPart && "text" in textPart) {
        message = textPart.text;
      }
      break;
    }

    const oneLineMessage = message.replace(/\n/g, " ").trim();
    const safeMessage = sanitizeOscValue(shortenMessage(oneLineMessage || "Task completed"));
    const safeTitle = sanitizeOscValue(NOTIFY_TITLE);

    if (!inTmux) {
      const sent = sendOsc9("/dev/tty", safeMessage);
      if (!sent) process.stdout.write(buildOsc(`9;${safeMessage}`));
      return;
    }

    try {
      await pi.exec("tmux", ["display-message", "-d", "2000", `Pi: ${safeMessage}`]);
    } catch {
      // Ignore tmux status errors; notification writes still attempted below.
    }

    const clientTtys = getTmuxClientTtys();
    let sent = false;

    for (const tty of clientTtys) {
      sent = sendOsc9(tty, safeMessage) || sent;
      sent = sendOsc777(tty, safeTitle, safeMessage) || sent;
    }

    if (sent) return;

    // Fallback when client tty discovery/write fails.
    process.stdout.write(buildTmuxPassthrough(`9;${safeMessage}`));
    process.stdout.write(buildTmuxPassthrough(`777;notify;${safeTitle};${safeMessage}`));
  });
}
