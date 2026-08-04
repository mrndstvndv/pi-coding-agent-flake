import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";

const STATUS_KEY = "session-age";
const TICK_MS = 1000;

// First JSONL line of a session file carries the session start timestamp.
function readSessionStartTime(sessionFile: string | undefined): number | undefined {
  if (!sessionFile) return undefined;
  try {
    const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { timestamp?: string };
    if (typeof header.timestamp === "string") {
      const time = Date.parse(header.timestamp);
      if (!Number.isNaN(time)) return time;
    }
  } catch {
    // Fall through to Date.now() fallback.
  }
  return undefined;
}

function formatAge(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopTicker() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    stopTicker();
    startedAt = readSessionStartTime(ctx.sessionManager.getSessionFile()) ?? Date.now();

    const update = () => {
      if (startedAt === undefined) return;
      const elapsed = Date.now() - startedAt;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatAge(elapsed)));
    };

    update();
    timer = setInterval(update, TICK_MS);
  });

  pi.on("session_shutdown", () => {
    stopTicker();
    startedAt = undefined;
  });
}
