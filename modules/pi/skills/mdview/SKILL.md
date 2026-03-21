---
name: mdview
description: Use the mdview CLI to serve Markdown as mobile-friendly HTML with rendered and raw views. Use when a user wants to preview Markdown from a phone/browser, start the server, or understand its routes and flags.
---

# mdview

Use the existing `mdview` CLI.
Do not rebuild it unless the user asks to change its implementation.

## Script location

- `bin/mdview`

## When to use

Use this skill when the task is about:
- previewing Markdown in a browser
- serving a directory of `.md` files for phone review
- serving one Markdown file with rendered + raw views
- explaining `mdview` flags, routes, or behavior
- running `mdview` for the user

## Command

```bash
mdview <path> [--host 0.0.0.0] [--port 3000]
```

Defaults:
- `--host 0.0.0.0`
- `--port 3000`

## What it serves

Allowed files:
- `.md`
- `.markdown`

Rejected:
- missing files
- non-Markdown files
- traversal outside the served root

## Modes

### Directory mode

Triggered when `<path>` is a directory.

Routes:
- `/` → directory index
- `/view/<relative-path>` → rendered Markdown
- `/raw/<relative-path>` → raw Markdown

### File mode

Triggered when `<path>` is a single Markdown file.

Routes:
- `/` → rendered Markdown
- `/raw` → raw Markdown

## Startup output

On startup `mdview` prints:
- served path
- detected mode
- local URL
- LAN URL when easy to detect
- warning when bound to `0.0.0.0`

## Agent workflow

1. Confirm the target path exists.
2. Run `mdview <path>` with optional `--host` / `--port`.
3. Share the printed URL with the user.
4. Mention the relevant routes if useful.
5. Leave the server running only as long as needed.

## Examples

Serve a directory on the default host/port:

```bash
mdview ./notes
```

Serve one file on a custom port:

```bash
mdview ./report.md --port 4123
```

Bind to localhost only:

```bash
mdview ./notes --host 127.0.0.1
```

## Notes for agents

- Default host is exposed. Mention that clearly.
- In directory mode, links use relative paths under the served root.
- Raw view is HTML with the Markdown shown inside `<pre><code>`.
- Rendered view uses `Bun.markdown.html(...)` with safe defaults.
- UI is mobile-first and follows system light/dark mode.

## If the user asks to modify mdview

Then inspect:
- `bin/mdview`
- `./references/mdview-spec.md`

Preserve:
- directory/file routing
- only `.md` and `.markdown`
- root confinement
- rendered + raw views
- mobile-friendly HTML output
- dark/light auto theme
