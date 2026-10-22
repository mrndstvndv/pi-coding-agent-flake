# Pi Subagent

Vendored from [earendil-works/pi-subagent](https://github.com/earendil-works/pi-subagent).

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation. Each child runs in its own Herdr tab with a dedicated Pi JSONL session.

This copy is loaded by the Nix-managed extension package. The Home Manager module exposes the `subagent` CLI and installs Node.js 24. Herdr's CLI must be on `PATH`; the parent Pi must run in a Herdr-managed pane (`HERDR_ENV=1`).

See [skills/subagent/SKILL.md](skills/subagent/SKILL.md) for usage and lifecycle guidance.
