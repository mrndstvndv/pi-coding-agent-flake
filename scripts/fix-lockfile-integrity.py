#!/usr/bin/env python3
"""Fill in missing integrity hashes in package-lock.json.

Some npm packages (e.g. @earendil-works/pi-coding-agent) ship npm-shrinkwrap.json
that omit integrity hashes. When npm install --ignore-scripts processes this,
the outer package-lock.json inherits those entries without integrity, causing
prefetch-npm-deps to panic with "non-git dependencies should have associated integrity".

This script downloads the missing packages from their resolved URLs and computes
the sha512 integrity hash, then writes the fixed lockfile.
"""

import json
import hashlib
import base64
import os
import sys
import urllib.request

LOCKFILE = sys.argv[1] if len(sys.argv) > 1 else "package/package-lock.json"

with open(LOCKFILE) as f:
    data = json.load(f)

packages = data.get("packages", {})
fixed = 0

for path, info in packages.items():
    if path == "":
        continue
    if info.get("integrity"):
        continue  # already has integrity
    resolved = info.get("resolved", "")
    if not resolved:
        continue
    # Skip git dependencies
    if "github.com" in resolved or "git+" in resolved:
        continue
    # Skip link dependencies
    if info.get("link"):
        continue

    # Download and compute integrity
    print(f"Computing integrity for {path}@v{info.get('version', '?')} ...", flush=True)
    try:
        resp = urllib.request.urlopen(resolved, timeout=30)
        content = resp.read()
        digest = hashlib.sha512(content).digest()
        integrity = "sha512-" + base64.b64encode(digest).decode()
        info["integrity"] = integrity
        fixed += 1
    except Exception as e:
        print(f"  WARNING: Failed to download {resolved}: {e}", flush=True)

if fixed:
    with open(LOCKFILE, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"Fixed {fixed} entries in {LOCKFILE}")
else:
    print("All entries already have integrity")
