# Vendored `pi-apply-patch`

This is a controlled snapshot of [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch).

- Upstream commit: `8f0d8a6ec67599305c19c92de328178e97522e1e`
- Imported: 2026-09-06
- Upstream license and attribution: `LICENSE` and `NOTICE`

Local fork changes: patch paths must be workspace-relative and cannot escape the active Pi working directory. This is stricter than upstream, which accepts absolute and parent-escaping paths. Atomic updates preserve the existing file permission bits, including executable mode.

To update deliberately, fetch a reviewed upstream commit into `/Users/steven/.pi/gh/pi-apply-patch`, compare `src/`, then replace the vendored source and update this commit identifier. Re-run the flake build after changing dependencies or source files.
