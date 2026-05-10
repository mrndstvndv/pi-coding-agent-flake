import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { networkInterfaces } from "node:os";

interface ServerInfo {
  process: ChildProcess;
  host: string;
  port: number;
  lanUrl: string | null;
}

const servers = new Map<string, ServerInfo>();

function getLanUrl(port: number): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      return `http://${addr.address}:${port}`;
    }
  }
  return null;
}

function startMdview(
  absolutePath: string,
  host: string,
  port: number,
): Promise<{ ok: true; process: ChildProcess; url: string; lanUrl: string | null } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("mdview", [absolutePath, "--host", host, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stderr = "";
    let resolved = false;

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();

      if (text.includes("mdview serving:")) {
        resolved = true;
        const lanUrl = getLanUrl(port);
        resolve({
          ok: true,
          process: proc,
          url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
          lanUrl,
        });
      }
    });

    proc.on("exit", (code) => {
      if (resolved) return;
      resolved = true;

      if (stderr.includes("already in use")) {
        resolve({ ok: false, error: `Port ${port} is already in use` });
        return;
      }

      resolve({
        ok: false,
        error: stderr.trim() || `mdview exited with code ${code}`,
      });
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve({ ok: false, error: "mdview failed to start within 10s" });
      }
    }, 10_000);

    proc.on("exit", () => clearTimeout(timeout));
  });
}

function stopAll() {
  for (const [key, info] of servers) {
    try {
      info.process.kill("SIGTERM");
    } catch {}
    servers.delete(key);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mdview",
    label: "Markdown Viewer",
    description:
      "Serve Markdown files as mobile-friendly HTML. Call with a path to preview in a browser accessible from LAN.",
    promptSnippet: "Serve Markdown files for browser preview on LAN",
    promptGuidelines: [
      "Use this tool when the user wants to preview Markdown files in a browser.",
      "The server binds to 0.0.0.0 by default, accessible from other devices on the LAN.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File or directory path to serve" }),
      host: Type.Optional(
        Type.String({ description: "Bind host (default: 0.0.0.0 — exposed to LAN)" }),
      ),
      port: Type.Optional(Type.Number({ description: "Bind port (default: 3000)" })),
    }),
    async execute(_id, params) {
      const host = params.host ?? "0.0.0.0";
      const port = params.port ?? 3000;
      const absolutePath = resolvePath(process.cwd(), params.path);

      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        throw new Error(`Path does not exist: ${absolutePath}`);
      }

      const isDir = fileStat.isDirectory();
      const isMd = /\.(md|markdown)$/i.test(absolutePath);
      if (!isDir && !isMd) {
        throw new Error(`Not a Markdown file or directory: ${absolutePath}`);
      }

      const result = await startMdview(absolutePath, host, port);

      if (!result.ok) {
        throw new Error(result.error);
      }

      servers.set(`${host}:${port}`, {
        process: result.process,
        host,
        port,
        lanUrl: result.lanUrl,
      });

      const lines = [`Serving: ${absolutePath}`, `Local: ${result.url}`];
      if (result.lanUrl) lines.push(`LAN: ${result.lanUrl}`);
      if (host === "0.0.0.0") lines.push("Warning: server exposed on all interfaces");
      lines.push("", "Routes:");
      lines.push("  / — directory index (or rendered view for single file)");
      lines.push("  /view/<file> — rendered Markdown");
      lines.push("  /raw/<file> — raw Markdown");
      lines.push("", `Stop: close the pi session or kill the process`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { url: result.url, lanUrl: result.lanUrl, path: absolutePath, host, port },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    stopAll();
  });

  pi.registerCommand("mdview-servers", {
    description: "List running mdview servers",
    handler: async (_args, ctx) => {
      if (servers.size === 0) {
        ctx.ui.notify("No mdview servers running", "info");
        return;
      }
      const lines = Array.from(servers.entries()).map(
        ([key, info]) => `${key} → ${info.url}${info.lanUrl ? ` | LAN: ${info.lanUrl}` : ""}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
