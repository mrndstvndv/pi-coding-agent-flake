---
name: apkmirror-dl
description: Download APKs and app bundles from APKMirror using the embedded apkmirror-dl CLI tool. Use when the user wants to download Android apps, APKs, XAPKs, or APKM bundles from APKMirror.
compatibility: Self-contained skill with embedded Python script. Uses uv for Python dependency management (cloudscraper, beautifulsoup4, requests).
metadata:
  author: twitter-apk
  version: "1.0"
---

# APKMirror Downloader Skill

This skill provides an embedded CLI tool to download Android apps from APKMirror.

## Quick Reference

The tool is embedded at `./scripts/apkmirror-dl`:

```bash
# Search for apps
./scripts/apkmirror-dl --search "app name"

# Download by APKMirror URL
./scripts/apkmirror-dl "https://www.apkmirror.com/apk/x-corp/twitter/"

# Download specific architecture
./scripts/apkmirror-dl "<url>" --arch arm64-v8a

# Download as APK (not bundle)
./scripts/apkmirror-dl "<url>" --arch arm64-v8a -o app.apk

# Download specific version
./scripts/apkmirror-dl "<url>" -v "11.67.0"
```

## Common Architectures

- `arm64-v8a` - Modern ARM64 devices (most common)
- `armeabi-v7a` - Older 32-bit ARM devices
- `x86_64` - Intel/AMD devices (emulators)
- `universal` - Works on all architectures (larger file)

## Workflow

1. **Search** if user doesn't provide URL:
   ```bash
   ./scripts/apkmirror-dl --search "x by x corp"
   ```
   Copy the appropriate result URL.

2. **Download** with architecture filter:
   ```bash
   ./scripts/apkmirror-dl "<url>" --arch arm64-v8a
   ```

3. **Verify** the download:
   ```bash
   ls -lh *.apk* *.apkm*
   ```

## Output Options

| Flag | Description |
|------|-------------|
| `-o, --output` | Custom output filename |
| `--bundle` | Prefer APKM bundle over APK |
| `--arch` | Filter by architecture |
| `-v, --version` | Specific version string |

## Examples

**Download X (Twitter) latest:**
```bash
./scripts/apkmirror-dl "https://www.apkmirror.com/apk/x-corp/twitter/" --arch arm64-v8a -o x_latest.apk
```

**Download specific version:**
```bash
./scripts/apkmirror-dl "https://www.apkmirror.com/apk/x-corp/twitter/" -v "11.67.0-release.0"
```

**Search and download:**
```bash
./scripts/apkmirror-dl --search "youtube"
# Then use the URL from results
./scripts/apkmirror-dl "https://www.apkmirror.com/apk/google-inc/youtube/" --arch arm64-v8a
```

## Troubleshooting

- **"Failed to fetch"**: APKMirror may be rate-limiting; wait a moment and retry
- **No variants found**: The version may be region-locked or removed; try a different version
- **Wrong architecture**: Verify device architecture with `adb shell getprop ro.product.cpu.abi`

## Script Location

The tool is embedded at `./scripts/apkmirror-dl` within this skill directory. It uses `uv` for automatic dependency management (cloudscraper, beautifulsoup4, requests).

## Copy to Project

To use the tool in your project root:

```bash
cp ./scripts/apkmirror-dl /path/to/your/project/
chmod +x /path/to/your/project/apkmirror-dl
```
