import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "session-age";

function formatAge(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI) {
  let firstUserAt: number | undefined;
  let lastTurnAt: number | undefined;

  pi.on("session_start", (_event, ctx) => {
    firstUserAt = undefined;
    lastTurnAt = undefined;

    // Resumed sessions already have history — recover the work window from it
    // so the age shows immediately instead of waiting for a new turn.
    const entries = ctx.sessionManager.getBranch();
    const messages = entries.filter(
      (entry): entry is SessionEntry & { type: "message" } => entry.type === "message",
    );
    const firstUser = messages.find((entry) => entry.message.role === "user");
    if (firstUser) {
      const start = Date.parse(firstUser.timestamp);
      const end = Date.parse(messages[messages.length - 1]!.timestamp);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        firstUserAt = start;
        lastTurnAt = end;
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("dim", formatAge(lastTurnAt - firstUserAt)),
        );
      }
    }
  });

  // Work window starts when the first user message of the session arrives.
  pi.on("message_start", (event) => {
    if (firstUserAt !== undefined || event.message.role !== "user") return;
    firstUserAt = Date.now();
  });

  // Freeze the window at the end of each turn: first user message -> last turn.
  pi.on("turn_end", (_event, ctx) => {
    if (firstUserAt === undefined) return;
    lastTurnAt = Date.now();
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatAge(lastTurnAt - firstUserAt)));
  });

  pi.on("session_shutdown", () => {
    firstUserAt = undefined;
    lastTurnAt = undefined;
  });
}
