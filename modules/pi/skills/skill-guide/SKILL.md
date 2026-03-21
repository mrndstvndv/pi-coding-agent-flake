---
name: skill-guide
description: Reference for creating pi skills and designing CLI scripts. Use when the user wants to create a new skill, design a CLI tool for agent use, or understand skill structure and conventions.
---

# Pi Skill Creation Guide

How to create skills and design their CLI scripts.

## Quick Start

```
my-skill/
├── SKILL.md
└── scripts/
    └── my-tool        # optional CLI
```

```markdown
---
name: my-skill
description: Does X when user needs Y. Be specific about triggers.
---

# My Skill

**Run via:** `./scripts/my-tool`

## Usage

\`\`\`bash
my-tool <input>              # Basic use
my-tool <input> --flag       # With options
\`\`\`

## Options

| Flag | Description |
|------|-------------|
| `-o, --output` | Output path |
| `--verbose` | Extra output |
```

The skill will be discovered if it lives in a skill directory (`~/.pi/agent/skills/`, `~/.pi/personal/skills/`, `.pi/skills/`, etc.).

## Skill Structure

```
my-skill/
├── SKILL.md              # Required. Frontmatter + instructions.
├── scripts/              # CLI tools the agent runs
│   ├── my-tool
│   └── helper.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/               # Templates, configs, etc.
    └── template.json
```

Rules:
- `SKILL.md` is required. Everything else is optional.
- Use **relative paths** in SKILL.md: `./scripts/my-tool`, `references/api.md`
- Skills are discovered by `SKILL.md` files under skill directories, or `.md` files at the skill directory root

## SKILL.md Frontmatter

```yaml
---
name: my-skill
description: What it does and when to use it. Be specific about trigger phrases.
compatibility: Optional environment requirements.
metadata:
  author: you
  version: "1.0"
---
```

### `name` (required)

- 1-64 characters
- Lowercase `a-z`, digits `0-9`, hyphens only
- No leading/trailing hyphens, no consecutive hyphens
- **Must match parent directory name**

Valid: `4chan`, `coomer-dl`, `apkmirror-dl`, `globe-router`
Invalid: `My-Skill`, `-foo`, `foo--bar`

### `description` (required)

- Max 1024 chars
- This is what the agent sees at startup to decide whether to load the skill
- Be specific about **when** to use it — include trigger phrases

Good:
```yaml
description: Download posts from Coomer creators (Fansly, OnlyFans) with metadata and attachments organized by post ID. Use when the user wants to download or archive content from Coomer.
```

Poor:
```yaml
description: Helps with Coomer.
```

## Writing Skill Content

The body of SKILL.md is instructions the agent reads when it loads the skill. Write for an LLM, not a human.

### Principles

1. **Lead with the command.** Show how to run it immediately.
2. **Examples first, explanation second.** Agents follow patterns.
3. **Use tables for options.** Easy to scan.
4. **Keep it concise.** Every token matters.
5. **Show common workflows**, not every edge case.

### Structure

```markdown
# Skill Title

**Run via:** `./scripts/tool-name`

## Usage

\`\`\`bash
# Most common use
tool-name <required-arg>

# With options
tool-name <required-arg> --flag value
\`\`\`

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output` | stdout | Output path |

## Examples

\`\`\`bash
# Do common thing
tool-name "input"

# Do other thing
tool-name "input" --flag
\`\`\`
```

### What to include

- **Usage block** with the most common invocation
- **Options table** — scannable, not prose
- **Examples** — real commands the agent can copy-paste
- **Output format** — show what the agent will see
- **Notes** — gotchas, rate limits, idempotency

### What to skip

- Installation steps (uv/bun handle deps)
- Verbose explanations of what the tool does (description covers it)
- API documentation (put in `references/` if needed)

## When to Include Scripts

Not every skill needs a script. Include one when:

| Include script | Skip script |
|----------------|-------------|
| Wraps an API the agent can't easily call | Skill is pure instruction (e.g., `pi-config`) |
| Complex multi-step workflow | Documents how to use an existing CLI (`mdview`) |
| Needs specific deps/headers/auth | Reference for config patterns (`opencode-free-models`) |
| Formats output for agent consumption | Just describes a process |

If the agent can do it with `curl` + `jq` in 1-3 commands, skip the script. If it needs parsing, state management, retries, or output formatting — include one.

## CLI Script Design

### General Principles

1. **Single responsibility.** One tool, one job.
2. **Positional args for the primary input.** Flags for everything else.
3. **Stdout for data, stderr for errors.** Never mix.
4. **Exit codes:** `0` success, `1` general error, `2` not found.
5. **Idempotent where possible.** Skip existing files, don't re-fetch.
6. **No config files.** All config via CLI args or env vars.
7. **No interactive prompts** unless unavoidable (globe-router credentials).
8. **Pipe-friendly output.** `|` delimited, one record per line, no decorative formatting.

### Argument Style Decision Tree

```
Is there one primary action?
├── Yes → Flat flags (apkmirror-dl, buzzheavier-dl, nyaa)
│         tool <primary-input> [flags]
│
├── Yes, but multiple distinct operations → Subcommands (4chan, globe)
│         tool <command> [args] [flags]
│
└── No, just positional args → Bare args (coomer-dl)
          tool <arg1> <arg2> [arg3]
```

### Shorthand Syntax

Accept alternative input formats to reduce typing:

```python
# 4chan accepts both:
4chan thread vt 110132668       # formal
4chan vt/110132668              # shorthand (pre-processed in argv)
```

Pre-process `sys.argv` before argparse to rewrite shorthand into canonical form.

## Python Scripts (uv)

Use this for most skills. Zero-install, deps managed at runtime.

### Shebang + Dependency Block

```python
#!/usr/bin/env -S uv run --script

# /// script
# requires-python = ">=3.11"
# dependencies = ["cloudscraper", "beautifulsoup4"]
# ///

"""One-line description."""

import sys
# ...
```

Key points:
- `#!/usr/bin/env -S uv run --script` — uv handles deps automatically
- Dependencies in the `# /// script` block — no requirements.txt, no setup.py
- Only list deps you actually import
- Use stdlib (`urllib.request`, `json`, `argparse`) when possible to minimize deps

### Argparse Patterns

**Flat flags (single action):**
```python
import argparse

parser = argparse.ArgumentParser(prog="tool", description="Short desc")
parser.add_argument("url", help="Input URL")
parser.add_argument("-o", "--output", help="Output path")
parser.add_argument("--info", action="store_true", help="Info only")
args = parser.parse_args()
```

**Subcommands (multiple operations):**
```python
parser = argparse.ArgumentParser(prog="tool")
sub = parser.add_subparsers(dest="cmd", required=True)

p_search = sub.add_parser("search", help="Search items")
p_search.add_argument("query", help="Search text")
p_search.add_argument("-l", "--limit", type=int, default=10)

p_get = sub.add_parser("get", help="Get item")
p_get.add_argument("id", help="Item ID")
```

**No argparse (simple tools):**
```python
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)

    name = sys.argv[1]
    service = sys.argv[2] if len(sys.argv) > 2 else "default"
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 20
```

Use this for tools with 2-4 positional args and no flags. Simpler than argparse, easier for agents to parse.

### HTTP Requests

Use stdlib when possible:
```python
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

req = Request(url, headers={"User-Agent": "tool/1.0"})
with urlopen(req, timeout=30) as resp:
    data = resp.read()
```

Use `cloudscraper` only when you need Cloudflare bypass:
```python
import cloudscraper
scraper = cloudscraper.create_scraper()
resp = scraper.get(url)
```

## TypeScript Scripts (bun)

Use for type safety or when you need bun APIs (serving, file watching, etc.).

### Shebang

```typescript
#!/usr/bin/env bun

interface Args {
  query?: string;
  limit?: number;
  format: "table" | "json";
}
```

### Argument Parsing

Hand-rolled is fine for small CLIs:
```typescript
function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Args = { format: "table" };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-l": case "--limit":
        result.limit = parseInt(args[++i], 10);
        break;
      case "--format":
        result.format = args[++i] as Args["format"];
        break;
      default:
        if (!args[i].startsWith("-") && !result.query) {
          result.query = args[i];
        }
    }
  }
  return result;
}
```

For complex CLIs with subcommands, use a library or keep the switch/case pattern.

### File Organization

Single file is ideal. Split into `src/` only when:
- Multiple scripts share code (nyaa: `scripts/nyaa` + `src/rss.ts` + `src/types.ts`)
- The script exceeds ~300 lines

## Bash Scripts

Use for simple system interaction (globe-router). Avoid for anything requiring JSON parsing, complex string handling, or HTTP beyond basic curl.

### Shebang

```bash
#!/bin/bash
set -u  # fail on undefined variables
```

### When to Use Bash

- Calling existing system commands (curl to a simple API)
- Gluing together other tools
- Managing credentials/keychain
- Router/switch/network device interaction

### When NOT to Use Bash

- JSON manipulation (use Python/TS)
- Complex argument parsing (use Python/TS)
- File downloading with progress (use Python/TS)
- Anything over ~200 lines

## Output Format Design

### Pipe-Delimited Tables

The standard for tabular data. Easy to parse, no escaping needed for simple data.

```python
# Header
print("id|name|status")
# Rows
print(f"{item['id']}|{item['name']}|{item['status']}")
```

```
id|name|status
1|widget|active
2|gadget|inactive
```

Why `|` over `,`:
- URLs contain commas and colons but rarely `|`
- No quoting/escaping needed
- `cut -d'|'` works cleanly

### Multi-Record Output

Use `---` as record separator:

```
#0|110132668|03/10/26(Tue)15:16:03
Subject line
Body text here, can be multiline.
---
#1|110132691|03/10/26(Tue)15:17:02
Another subject
Another body.
---
```

### Metadata Header

For fetched content, include a metadata line before the records:

```
thread=110132668 board=vt posts=184 range=0:9
---
```

### JSON Output

Add `--format json` when structured data is useful:

```python
parser.add_argument("--format", default="table", choices=["table", "json"])
# ...
if args.format == "json":
    print(json.dumps(items, indent=2))
else:
    for item in items:
        print(format_table(item))
```

### Extract Modes

Common pattern — default shows everything, flags extract specific fields:

```bash
tool <input>              # full output
tool <input> --links      # URLs only, one per line
tool <input> --images     # image URLs only
tool <input> --format json  # structured
```

```python
if args.links:
    for item in items:
        for url in extract_links(item):
            print(url)
```

### Link/Image Extraction

Format: `#<index>|<extracted-value>`

```
#0|https://example.com/link1 https://example.com/link2
#3|https://example.com/link3
```

Skip records with no matches (don't print empty lines).

## Error Handling

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (network, parse, auth) |
| 2 | Not found (HTTP 404, missing resource) |

### Error Messages

Always to stderr:

```python
print(f"Error: Thread {id} not found", file=sys.stderr)
sys.exit(2)
```

### HTTP Errors

```python
from urllib.error import HTTPError, URLError

try:
    with urlopen(req) as resp:
        data = json.load(resp)
except HTTPError as e:
    if e.code == 404:
        print(f"Error: Resource not found", file=sys.stderr)
        sys.exit(2)
    print(f"Error: HTTP {e.code}", file=sys.stderr)
    sys.exit(1)
except URLError as e:
    print(f"Error: {e.reason}", file=sys.stderr)
    sys.exit(1)
```

### Missing Args

```python
if len(sys.argv) < 2:
    print(__doc__)
    raise SystemExit(1)
```

Or with argparse:
```python
parser = argparse.ArgumentParser()
# argparse handles --help and missing required args automatically
```

## Advanced Patterns

### Credential Resolution Chain

Layered lookup (globe-router pattern):

```
1. CLI flags:     --user, --pass
2. Environment:   TOOL_USER, TOOL_PASS
3. Keychain:      macOS security command
4. File:          ~/.config/local/tool.env
5. Interactive:   prompt (last resort)
```

```bash
resolve_credentials() {
    # Try CLI flags
    # Try env vars
    # Try keychain
    # Try file
    # Prompt interactively
}
```

### Idempotent Downloads

Check before downloading:

```python
def download_file(url: str, dest: Path) -> bool:
    if dest.exists():
        print(f"    skip: {dest.name}")
        return False
    # ... download ...
    return True
```

### Progress Reporting

For batch operations:

```python
for i, item in enumerate(items, 1):
    print(f"[{i}/{len(items)}] Processing {item['id']}...")
    process(item)
```

### Retry with Backoff

```python
def download_with_retry(url: str, retries: int = 3) -> bytes:
    for attempt in range(retries):
        try:
            return fetch(url)
        except (HTTPError, URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise
```

### Size Limits

Skip large files:

```python
def get_content_length(url: str) -> int | None:
    req = Request(url, headers={**HEADERS, "Accept-Encoding": "identity"})
    req.get_method = lambda: "HEAD"
    with urlopen(req, timeout=15) as resp:
        cl = resp.headers.get("Content-Length")
        return int(cl) if cl else None

# In download:
size = get_content_length(url)
if max_mb and size and size > max_mb * 1024 * 1024:
    print(f"    SKIP: {size // 1024 // 1024}MB (over {max_mb}MB limit)")
    return False
```

## Placement

| Location | Scope | Use for |
|----------|-------|---------|
| `~/.pi/agent/skills/` | Global, nix-managed | Public/bundled skills |
| `~/.pi/personal/skills/` | Global, private | Personal/experimental skills |
| `.pi/skills/` | Project | Project-specific skills |
| `~/.agents/skills/` | Global, shared | Cross-harness skills |

### Private vs Public

- **Public** (in nixdots): Shareable, polished, stable
- **Private** (`~/.pi/personal/`): Experimental, personal API keys, one-off tools

## Testing

1. Place skill in a skill directory
2. Run `/reload` in pi (or restart)
3. Describe a task that should trigger the skill
4. Verify the agent loads SKILL.md and runs the script correctly

Test edge cases:
- Missing required args
- Invalid input
- Network errors
- Empty results
- Large outputs

## Checklist

### SKILL.md
- [ ] `name` matches parent directory
- [ ] `name` is lowercase, 1-64 chars, no consecutive hyphens
- [ ] `description` is specific about when to use it
- [ ] Frontmatter has required fields (`name`, `description`)
- [ ] Body shows usage examples first
- [ ] Options are in a table
- [ ] Paths are relative (`./scripts/tool`)

### CLI Script
- [ ] Correct shebang (`#!/usr/bin/env -S uv run --script` or `#!/usr/bin/env bun`)
- [ ] Dependencies declared inline (Python) or in package.json (TS)
- [ ] Primary input is positional, modifiers are flags
- [ ] Stdout for data, stderr for errors
- [ ] Exit codes: 0 success, 1 error, 2 not found
- [ ] Idempotent where applicable
- [ ] No interactive prompts (unless unavoidable)
- [ ] Output is pipe-delimited or JSON
- [ ] Handles missing args gracefully
- [ ] Handles HTTP errors gracefully
- [ ] Executable (`chmod +x`)

## Reference: Existing Skills

| Skill | Style | Runtime | Complexity |
|-------|-------|---------|------------|
| `4chan` | Subcommands | Python/uv | Medium — thread/index/catalog/boards |
| `archive` | Subcommands | Python/uv | Medium — search/thread/archives/boards |
| `coomer-dl` | Bare positional | Python/uv | Low — download posts |
| `apkmirror-dl` | Flat flags | Python/uv | Medium — search/download |
| `buzzheavier-dl` | Flat flags | Python/uv | Low — download file |
| `nyaa` | Flat flags | Bun/TS | Low — search torrents |
| `globe-router` | Subcommands | Bash | Medium — status/traffic/wifi/reboot |
| `mdview` | No script | Bun/TS | None — documents existing CLI |
| `agent-browser` | Subcommands | npm package | High — full browser automation |
| `pi-config` | No script | — | None — documents config patterns |
| `opencode-free-models` | No script | — | None — documents process |
