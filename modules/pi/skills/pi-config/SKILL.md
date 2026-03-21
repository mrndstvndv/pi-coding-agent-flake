---
name: pi-config
description: Declarative pi config for nixdots. Use when changing pi settings, skills, prompt templates, themes, or extensions under modules/pi/.
---

# Pi Config

All pi config is source-controlled in `modules/pi/`. Edit that tree, not the live `~/.pi/agent/` install paths.

## Source of truth

```
modules/pi/
├── AGENTS.md            # Global pi instructions
├── default.nix          # Home Manager module + generated settings
├── settings.json         # Base pi settings read by Nix
├── models.json           # Custom provider/model definitions (e.g. OpenRouter Qwen)
├── package/             # NPM package for custom extensions
│   ├── package.json
│   ├── package-lock.json
│   └── extensions/
├── skills/              # Custom skills (recursive SKILL.md discovery)
├── prompt-templates/    # Markdown prompt templates
└── themes/              # Theme JSON files
```

## Architecture

- `default.nix` owns the live `~/.pi/agent/settings.json` file.
- `settings.json` is the base config; `default.nix` merges in generated values.
- The module builds `package/` with `pkgs.buildNpmPackage`.
- `npmDepsHash` must be updated whenever `package/package-lock.json` changes.
- If the `piAgent` flake input exists, the module installs the `pi` binary from that flake and derives `lastChangelogVersion` from the package version.
- The generated settings inject:
  - the built extension package path
  - the local `../personal` package path, which resolves to `~/.pi/personal`
  - the active theme (`no-thinking-bg`)
  - `themes = [ "~/.pi/agent/themes" ]`
  - `hideThinkingBlock = true`
- `~/.pi/personal` is for private/internal pi stuff not meant for public sharing.
- Put private skills in `~/.pi/personal/skills/`, private extensions in `~/.pi/personal/extensions/`, private prompt templates in `~/.pi/personal/prompts/`, and private themes in `~/.pi/personal/themes/` when they should stay out of the public nixdots module.

## What to edit

- **Settings**: `modules/pi/settings.json`
- **Custom models/providers**: `modules/pi/models.json` (symlinked to `~/.pi/agent/models.json`)
- **Generated settings / package wiring**: `modules/pi/default.nix`
- **Extensions**: `modules/pi/package/extensions/*.ts`
- **Extension deps**: `modules/pi/package/package.json` + `package-lock.json`
- **Skills**: `modules/pi/skills/<name>/SKILL.md`
- **Prompt templates**: `modules/pi/prompt-templates/*.md`
- **Themes**: `modules/pi/themes/*.json`

## Important behavior

- Do not hand-edit `~/.pi/agent/settings.json`; Home Manager will overwrite it.
- Do not hand-edit `~/.pi/agent/models.json`; Home Manager will overwrite it.
- `models.json` replaces the built-in model list for a provider. Only models listed there will appear in `/model`. To add more models, append to the array.
- Use `/reload` in pi after changing skills, prompts, or extensions.
- Themes hot-reload automatically.
- Skills are discovered recursively from `SKILL.md` files under `skills/`.
- `pi config` can toggle installed resources, but declarative config is the source of truth here.
- Relative paths in pi settings resolve from `~/.pi/agent/`, so keep generated paths deterministic.
- Third-party extensions run with full system access. Review code before enabling anything external.

## Less obvious pi features worth using

- `packages` accepts object filters, not just strings, if you need to narrow what a package loads.
- `enableSkillCommands` controls `/skill:name` registration.
- `npmCommand` can pin npm installs to a wrapper like `mise` or `asdf`.
- Skills can live in other harness dirs too, but this module only manages `modules/pi/skills/`.
- Prompt templates expand with `/name`.
- Pi packages can auto-discover `extensions/`, `skills/`, `prompts/`, and `themes/` when no `pi` manifest is present.

## Extension package notes

- The `package/` tree is a standalone pi package.
- Resources are registered in `package/package.json` under the `pi` key.
- Local extension entrypoints should stay relative to the package root, e.g. `./extensions/web-fetch.ts`.
- If you add a dependency, update the lockfile, then refresh `npmDepsHash` in `default.nix`.
- The module already uses this package for custom tooling like web fetch/search, LSP, notifications, and handoff helpers.

## Rebuild path

After config changes, rebuild Home Manager / Darwin, then reload pi if it is already running.
