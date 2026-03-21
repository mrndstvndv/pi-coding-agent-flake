# mdview spec

## Goal

Tiny Bun CLI that serves a directory of Markdown files as mobile-friendly HTML pages for quick review from a phone browser.

Primary workflow:
- SSH into home server from phone
- run one command against a directory
- open the printed URL in mobile browser
- browse agent-generated `.md` files with a clean responsive UI
- stop server when done

## Non-goals

- Full docs platform
- Permanent publishing pipeline
- Rich CMS/editor
- Search indexing
- Auth in v1
- Live collaborative editing

## User stories

- As a user, I can run `mdview some-dir/` and browse all Markdown files in that directory from my phone.
- As a user, the server is exposed by default so I can open it from another device on my network or via Tailscale/reverse proxy.
- As a user, rendered pages follow my browser or OS dark/light preference automatically.
- As a user, the UI is optimized for small screens first, then scales up on desktop.
- As a user, I can switch between rendered and raw Markdown when reviewing agent output.
- As a user, I can navigate back to the directory index easily.

## CLI

### Command

```bash
mdview <path>
```

### Input

`<path>` may be:
- a directory: serve an index of Markdown files under that root
- a single Markdown file: serve that file directly, with optional local navigation context

### Flags

```bash
mdview <path> [--host 0.0.0.0] [--port 3000]
```

V1 flags:
- `--host`: default `0.0.0.0`
- `--port`: default `3000`

Optional later:
- `--open`
- `--no-raw`
- `--title <name>`
- `--watch`

## Default behavior

### Bind address

Default bind:
- `0.0.0.0`

Reason:
- user explicitly wants exposed by default
- optimized for phone review from another device

### Port

Default:
- `3000`

If occupied:
- fail fast with clear error in v1
- optional later: `--port 0` auto-pick free port

### Printed output

On startup print:
- served root path
- detected mode: file or directory
- local URL
- LAN URL if easy to detect

Example:

```text
mdview serving: /srv/agent-output
mode: directory
url: http://192.168.1.10:3000
```

## Routing

### Directory mode

Routes:
- `/` → directory index
- `/view/<relative-path>` → rendered HTML view
- `/raw/<relative-path>` → raw Markdown view

### File mode

Routes:
- `/` → rendered HTML for file
- `/raw` → raw Markdown

## File handling

### Scope

Serve only files under the resolved root path.

### Allowed files

V1:
- `.md`
- `.markdown`

Optional later:
- `.mdx` as raw only or unsupported with clear error

### Path safety

Requirements:
- resolve root once at startup
- resolve requested file against root
- reject traversal outside root
- reject missing files with 404
- reject non-markdown files in view/raw routes

## Rendering

### Renderer

Use Bun built-in Markdown renderer:

```ts
Bun.markdown.html(markdown, options)
```

### Default renderer options

Safer default config:

```ts
{
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  headings: { ids: true },
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tagFilter: true,
}
```

Reason:
- agent output is usually trusted, but preview server should still prefer safer defaults
- heading ids improve mobile navigation and deep links

## HTML shell

Each rendered page uses a minimal HTML document wrapper with:
- proper viewport meta tag
- semantic content container
- theme-aware CSS
- top nav
- file metadata area
- rendered article body

### Required head tags

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
```

## Theme system

### Requirement

Theme follows browser/system preference automatically.

Implementation:
- CSS variables
- `@media (prefers-color-scheme: dark)`
- no manual theme toggle required in v1

### Theme goals

- readable in bright and dark environments
- strong contrast
- pleasant for long scrolling on mobile
- code blocks and tables readable in both modes

### CSS token groups

Define variables for:
- page background
- surface background
- text primary
- text muted
- border
- link
- link visited
- code inline background
- code block background
- code block text
- quote border
- quote background
- table stripe/surface
- accent

## Mobile-first UI

### Priority

Phone UX first. Desktop just scales up.

### Layout rules

- single column by default
- comfortable tap targets
- sticky top nav allowed if it stays compact
- content width constrained for readability on larger screens
- generous line height
- avoid sidebars in v1
- avoid tiny metadata text

### Breakpoints

Simple breakpoints only:
- mobile default
- tablet/desktop enhancement at ~768px+

### Required pages

#### Directory index

Must show:
- root title/path
- list of markdown files
- each entry as large tappable card/row
- relative path
- optional modified time if cheap to get

Nice-to-have later:
- nested folder grouping
- sort modes

#### Markdown view

Must show:
- back link to index
- file title/path
- action links: Rendered / Raw
- rendered article
- readable heading hierarchy
- horizontal scrolling for wide tables/code blocks

#### Raw view

Must show:
- same nav/header as rendered page
- raw markdown inside preformatted block
- wrap disabled by default for fidelity, but container must scroll horizontally

## Typography

### Body

- system UI font stack
- base size tuned for mobile readability
- line length capped on wide screens

### Markdown content

Style support for:
- headings h1-h6
- paragraphs
- links
- inline code
- fenced code blocks
- blockquotes
- lists
- tables
- horizontal rules
- images

### Images

Rules:
- max-width: 100%
- auto height
- rounded corners optional

## Code blocks

V1:
- no syntax highlighting required
- preserve whitespace
- horizontal scroll if needed
- high-contrast surface in both themes

Optional later:
- Shiki or lightweight highlighting

## Tables

V1 behavior:
- wrap table in horizontal scroll container
- keep cells readable on narrow screens
- use borders and spacing that work in dark mode

## Navigation

### Required controls

Rendered page:
- `Back`
- `Rendered`
- `Raw`

Index page:
- page title
- root path

### Deep linking

Support direct links to:
- individual file pages
- heading anchors generated by Bun headings option

## Error pages

Need simple HTML error pages for:
- 404 missing file
- invalid path
- unsupported file type
- internal render error

Requirements:
- human-readable
- same theme CSS
- include link back to root if possible

## Performance

### V1 expectations

- render on request
- no cache layer required initially
- directory listing should feel instant for normal agent output folders

### Optional later

- cache rendered HTML by file mtime
- ETag or last-modified headers

## Security

### Default posture

Personal server tool, but still avoid obvious footguns.

Requirements:
- root confinement
- no raw HTML blocks/spans in markdown rendering by default
- no directory traversal
- no execution of embedded content
- no upload endpoints

### Exposure note

Because default host is `0.0.0.0`, CLI output should warn clearly:

```text
warning: server is exposed on all interfaces
```

Optional later:
- `--host 127.0.0.1` for local-only mode

## Suggested implementation structure

```text
src/
  cli.ts
  server.ts
  routes.ts
  render.ts
  html.ts
  files.ts
  styles.ts
```

### Responsibilities

- `cli.ts`: args, path mode, startup logging
- `server.ts`: Bun.serve setup
- `routes.ts`: request routing
- `render.ts`: markdown -> html page assembly
- `html.ts`: document wrappers and page templates
- `files.ts`: path resolution, listing, safety checks
- `styles.ts`: CSS string with light/dark responsive theme

## MVP acceptance criteria

- running `mdview some-dir/` starts a Bun server on `0.0.0.0:3000`
- visiting `/` on phone shows a readable index of Markdown files
- tapping a file opens a rendered HTML page
- rendered pages adapt automatically to browser light/dark preference
- UI is mobile-friendly and responsive
- raw markdown view exists
- links and code blocks are readable on small screens
- path traversal outside root is blocked
- only markdown files are served

## Future enhancements

- recursive tree view with folder collapsing
- search/filter on index page
- file watcher with auto-refresh
- syntax highlighting
- copy link / share link buttons
- QR code for quick phone open from desktop shell
- auth/basic auth for public exposure
- static export mode
- alternate themes
- sort by modified time
