import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Server } from "node:http";
import { execSync, exec } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  let server: Server | null = null;
  let cachedHtml = "";
  let port = 0;
  let reloadToken = "";
  let expand = false;
  let numbers = true;
  let prevCwd = "";

  // FIX #7: helper to escape user-controlled strings before inserting into HTML
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Pierre's SSR output contains :host {} selectors throughout — they only resolve
  // inside a shadow DOM. We use Declarative Shadow DOM (shadowrootmode="open"),
  // which is supported in all modern browsers and requires zero JavaScript.
  // The prerenderedHTML already embeds all of pierre's own CSS (@layer base/theme/
  // rendered/unsafe), so we just drop it straight into the shadow root.
  function wrapInShadowDom(pierreHtml: string): string {
    // Use <diffs-container> as the shadow host — this is pierre's own custom element
    // tag, confirmed by reading diffs.com's source HTML. Matches intended usage exactly.
    return `<diffs-container><template shadowrootmode="open">${pierreHtml}</template></diffs-container>`;
  }

  // Passed to pierre via the `unsafeCSS` option so it lands inside @layer unsafe
  // (highest priority in pierre's own layer stack) and is baked into the shadow
  // root output alongside pierre's own styles.
  //
  // ROOT CAUSE of the horizontal-scroll background-clipping bug:
  //   pierre's SSR always marks elements with `data-dehydrated`, which switches
  //   the grid content column from `1fr` to `minmax(0, 1fr)`.
  //   `minmax(0, 1fr)` hard-caps the column at the visible container width, so
  //   [data-line] elements can never be wider than the viewport — their
  //   background-color clips at the right edge and doesn't travel during scroll.
  //
  //   diffs.com avoids this because React hydration removes `data-dehydrated`
  //   after mount. We don't have that JS step (pure SSR), so we fix it in CSS
  //   by overriding --diffs-code-grid to use `max-content` for the content column.
  //   `max-content` makes the grid as wide as the longest line; the overflow
  //   container then actually scrolls and all line backgrounds extend correctly.
  const UNSAFE_CSS = `
    [data-diff][data-dehydrated],
    [data-file][data-dehydrated] {
      --diffs-code-grid: var(--diffs-grid-number-column-width) max-content;
    }
  `;

  function renderDiffPage(diffHtml: string, hasChanges: boolean): string {
    const status = hasChanges ? "Changes detected" : "No changes";
    const diffSection = hasChanges
      ? wrapInShadowDom(diffHtml)
      : "<p style='color:#666;padding:2rem;text-align:center;font-size:1.2em'>No changes in working tree</p>";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>git diff \u2014 ${status}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.75rem 1.5rem;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    position: sticky; top: 0; z-index: 100;
  }
  header h1 {
    font-size: 1rem; font-weight: 600; color: #e6edf3;
    display: flex; align-items: center; gap: 0.5rem;
  }
  header h1 span { color: #8b949e; font-weight: 400; }
  header .actions { display: flex; gap: 0.5rem; align-items: center; }
  .btn {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.9rem; font-size: 0.8rem; font-weight: 500;
    border: 1px solid #30363d; border-radius: 6px;
    cursor: pointer; background: #21262d; color: #c9d1d9;
    text-decoration: none; transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-active { background: #1f2d3d; border-color: #388bfd; color: #79c0ff; }
  .btn-active:hover { background: #263a50; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #3fb950;
  }
  .status-dot.empty { background: #484f58; }
  #diff-container { padding: 0; }
  .spinner { display: none; }
  .loading .spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid #30363d; border-top-color: #c9d1d9;
    border-radius: 50%; animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading .btn-text { display: none; }
  #reload-status {
    font-size: 0.75rem; color: #8b949e;
    transition: opacity 0.3s; opacity: 0;
  }
  #reload-status.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>
    <span class="status-dot${hasChanges ? "" : " empty"}"></span>
    git diff
    <span>${status}</span>
  </h1>
  <div class="actions">
    <button class="btn${numbers ? " btn-active" : ""}" id="numbers-btn"
      data-numbers="${numbers ? "1" : "0"}"
      onclick="toggleNumbers()"
      title="Toggle line numbers">
      #
    </button>
    <button class="btn btn-primary" id="reload-btn" onclick="reloadDiff()">
      <span class="spinner"></span>
      <span class="btn-text">\u21bb Reload</span>
    </button>
    <span id="reload-status"></span>
  </div>
</header>
<div id="diff-container">${diffSection}</div>
<script>
// Declarative Shadow DOM (shadowrootmode) only activates during initial HTML
// parsing. When content is injected via innerHTML the <template> is inert —
// the shadow root never attaches and nothing renders. This helper iterates
// every such template and imperatively creates the shadow root, which is the
// standard polyfill pattern recommended by web.dev.
function hydrateShadowRoots(root) {
  root.querySelectorAll('template[shadowrootmode]').forEach(t => {
    const shadow = t.parentNode.attachShadow({ mode: t.getAttribute('shadowrootmode') });
    shadow.appendChild(t.content);
    t.remove();
  });
}
function currentNumbers() {
  return document.getElementById('numbers-btn').dataset.numbers !== '0';
}
async function fetchDiff(nums) {
  return fetch('/api/diff-raw?t=${reloadToken}&numbers=' + (nums ? '1' : '0'));
}
async function swapDiff(html) {
  const container = document.getElementById('diff-container');
  container.innerHTML = html;
  hydrateShadowRoots(container);
}
async function reloadDiff() {
  const btn = document.getElementById('reload-btn');
  const st = document.getElementById('reload-status');
  btn.classList.add('loading'); btn.disabled = true;
  st.textContent = 'Reloading...'; st.className = 'show';
  try {
    const r = await fetchDiff(currentNumbers());
    if (!r.ok) { st.textContent = 'Error: ' + r.status; return; }
    await swapDiff(await r.text());
    st.textContent = new Date().toLocaleTimeString() + ' \u2014 updated';
  } catch (e) { st.textContent = 'Failed: ' + e.message; }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
}
async function toggleNumbers() {
  const btn = document.getElementById('numbers-btn');
  const st = document.getElementById('reload-status');
  const newNums = btn.dataset.numbers === '0';
  btn.disabled = true;
  st.textContent = 'Updating...'; st.className = 'show';
  try {
    const r = await fetchDiff(newNums);
    if (!r.ok) { st.textContent = 'Error: ' + r.status; return; }
    await swapDiff(await r.text());
    btn.dataset.numbers = newNums ? '1' : '0';
    btn.classList.toggle('btn-active', newNums);
    st.textContent = 'Line numbers ' + (newNums ? 'on' : 'off');
  } catch (e) { st.textContent = 'Failed: ' + e.message; }
  finally { btn.disabled = false; }
}
</script>
</body>
</html>`;
  }

  // FIX #9: async exec to avoid blocking the event loop
  function getDiffOutput(cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec("git diff", {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  async function buildDiffHtml(cwd: string, expandOpt = false, numbersOpt = true): Promise<{ html: string; hasChanges: boolean }> {
    try {
      const { preloadPatchFile } = await import("@pierre/diffs/ssr");
      const output = await getDiffOutput(cwd);
      if (!output.trim()) {
        return { html: "", hasChanges: false };
      }
      const results = await preloadPatchFile({
        patch: output,
        options: {
          diffStyle: "unified",
          expandUnchanged: expandOpt,
          disableLineNumbers: !numbersOpt,
          // Inject our CSS fix via the official unsafeCSS API (rendered into
          // @layer unsafe, which has the highest priority in pierre's layer stack).
          // This avoids the shadow DOM wrapper entirely.
          unsafeCSS: UNSAFE_CSS,
        },
      });
      // pierre's prerenderedHTML is self-contained (has all its own <style> tags)
      // but uses :host selectors throughout, so it must live inside a shadow DOM.
      // We join the per-file blocks and the caller wraps in wrapInShadowDom().
      return {
        html: results.map((r) => r.prerenderedHTML).join("\n"),
        hasChanges: true,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        // FIX #7: escape error message to prevent XSS
        html: `<p style='color:#f85149;padding:2rem;'>Error: ${escapeHtml(msg)}</p>`,
        hasChanges: false,
      };
    }
  }

  async function refreshDiff(cwd: string, expandParam = false, numbersParam = true): Promise<{ html: string; fullPage: string }> {
    expand = expandParam;
    numbers = numbersParam;
    const { html, hasChanges } = await buildDiffHtml(cwd, expand, numbers);
    cachedHtml = renderDiffPage(html, hasChanges);
    return { html, fullPage: cachedHtml };
  }

  function parseOptions(url: URL): { expand: boolean; numbers: boolean } {
    return {
      expand: url.searchParams.get("expand") === "1",
      numbers: url.searchParams.get("numbers") !== "0",
    };
  }

  function createDiffServer(cwd: string): Server {
    return createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/api/reload") {
        const opts = parseOptions(url);
        expand = opts.expand;
        numbers = opts.numbers;
        try {
          const diffHtml = await refreshDiff(cwd, expand, numbers);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(diffHtml.fullPage);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(500);
          res.end(escapeHtml(msg));
        }
        return;
      }

      if (url.pathname === "/api/diff-raw") {
        // FIX #4: validate reloadToken before serving diff data
        if (url.searchParams.get("t") !== reloadToken) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        const opts = parseOptions(url);
        try {
          const { html, hasChanges } = await buildDiffHtml(cwd, opts.expand, opts.numbers);
          // FIX #10: Cache-Control: no-cache, no-store to prevent stale diffs
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
          });
          res.end(hasChanges
            ? wrapInShadowDom(html)
            : "<p style='color:#666;padding:2rem;text-align:center;font-size:1.2em'>No changes in working tree</p>"
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(500);
          res.end(escapeHtml(msg));
        }
        return;
      }

      if (url.pathname === "/api/cwd") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cwd }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(cachedHtml);
    });
  }

  function listenOnPort(srv: Server, p: number): Promise<number> {
    return new Promise((resolve, reject) => {
      srv.listen(p, "0.0.0.0", () => {
        const addr = srv.address();
        resolve(addr && typeof addr === "object" ? addr.port : p);
      });
      srv.once("error", reject);
    });
  }

  async function findExistingServer(cwd: string): Promise<number | null> {
    const basePort = parseInt(process.env.DIFF_HOST_PORT ?? "", 10) || 8080;
    // FIX #3: per-request AbortController with a short timeout
    for (let p = basePort; p < basePort + 100; p++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/cwd`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json() as { cwd: string };
          if (data.cwd === cwd) return p;
        }
      } catch {
        // port unreachable or no response, skip
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  }

  async function startServer(cwd: string): Promise<number> {
    // FIX #5/#6: restart server if cwd has changed
    if (server) {
      if (cwd === prevCwd) return port;
      stopServer();
    }

    // Check if another pi instance already serves this cwd
    const existing = await findExistingServer(cwd);
    if (existing !== null) {
      port = existing;
      prevCwd = cwd;
      return port;
    }

    prevCwd = cwd;
    expand = false;
    numbers = true;
    reloadToken = randomBytes(8).toString("hex"); // must be set before refreshDiff so it's baked into the rendered HTML
    await refreshDiff(cwd, expand, numbers);

    const basePort = parseInt(process.env.DIFF_HOST_PORT ?? "", 10) || 8080;

    for (let tryPort = basePort; tryPort < basePort + 100; tryPort++) {
      const srv = createDiffServer(cwd);
      try {
        port = await listenOnPort(srv, tryPort);
        server = srv;
        return port;
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        srv.close();
        if (e.code !== "EADDRINUSE") {
          throw e;
        }
        // Port busy, try next
      }
    }

    throw new Error(`No free port in range ${basePort}-${basePort + 99}`);
  }

  function stopServer() {
    if (server) {
      server.close();
      server = null;
      port = 0;
    }
  }

  pi.registerCommand("diff", {
    description: "Start a web server showing git diff output. Port: /diff 9090 or $DIFF_HOST_PORT",
    handler: async (args, ctx) => {
      if (args.trim()) process.env.DIFF_HOST_PORT = args.trim();

      try {
        execSync("git rev-parse --git-dir", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      try {
        const p = await startServer(ctx.cwd);
        ctx.ui.notify(`Diff server at http://localhost:${p}`, "info");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Failed to start server: ${msg}`, "error");
      }
    },
  });

  pi.on("session_shutdown", () => stopServer());
}
