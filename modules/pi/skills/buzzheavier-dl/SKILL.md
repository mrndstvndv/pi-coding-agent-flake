---
name: buzzheavier-dl
description: Download files from BuzzHeavier file hosting. Extracts direct download links bypassing Cloudflare protection. Use for downloading files from buzzheavier.com URLs.
compatibility: Uses uv for Python (cloudscraper). Requires aria2c for downloads.
metadata:
  author: steven
  version: "1.0"
---

# BuzzHeavier Downloader

## Setup

No setup required. Uses uv for Python dependencies.

## Usage

```bash
# Download to current directory
buzzheavier-dl "https://buzzheavier.com/yx1fzj4htmfq"

# Custom filename
buzzheavier-dl "https://buzzheavier.com/yx1fzj4htmfq" -o game.rar

# File info only
buzzheavier-dl "https://buzzheavier.com/yx1fzj4htmfq" --info

# Download + verify hash (if available on page)
buzzheavier-dl "https://buzzheavier.com/yx1fzj4htmfq" --hash
```

## Options

| Flag | Description |
|------|-------------|
| `-o, --output` | Output filename |
| `--info` | Show file info only (filename, size, SHA-1) |
| `--extract-only` | Show direct download URL only |
| `--hash` | Show and verify SHA-1 after download |

## Script Location

Run via: `./scripts/buzzheavier-dl`
