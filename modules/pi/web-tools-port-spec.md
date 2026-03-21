# Web tools port spec

Port OpenCode's `web_fetch` and `web_search` tools into the pi config package.

## Scope
- Replace the current `web_fetch` implementation that calls `markdown.new`.
- Add a new `web_search` tool backed by Exa's MCP endpoint.
- Keep permission plumbing out of scope. pi already handles tool registration and execution context.
- Keep config changes Nix-managed in `modules/pi/` only.

## Checklist
- [x] Analyze OpenCode's tool behavior and pi's tool contract
- [x] Add the `turndown` dependency to `modules/pi/package/package.json`
- [x] Reimplement `web_fetch` with URL validation, timeout, Cloudflare retry, image handling, and markdown/text/html conversion
- [x] Add `web_search` with Exa MCP POST, SSE parsing, timeout, and result extraction
- [x] Register the new tool in the pi package manifest
- [x] Refresh `package-lock.json` and update `npmDepsHash` in `modules/pi/default.nix`
- [x] Sanity-check the final package layout and tool names

## Implementation notes
- Use `TurndownService` for HTML to markdown conversion.
- Use a lightweight HTML-to-text fallback for `format: "text"`.
- Use pi's built-in truncation helpers so tool output stays manageable.
- Keep `web_fetch` and `web_search` names stable for prompt compatibility.
- Do not add or change `AGENTS.md`.
