# pi-coding-agent-flake

Nix flake packaging [pi](https://github.com/badlogic/pi-mono) coding agent with custom extensions, skills, prompt templates, and themes. Home Manager module manages `~/.pi/agent/` declaratively.

## Structure

```
.
├── flake.nix                          # Flake entry: builds pi binary + HM module
├── modules/pi/
│   ├── default.nix                    # Home Manager module (all settings + symlinks, extension build)
│   ├── models.json                    # Custom provider/model definitions → symlinked to ~/.pi/agent/models.json
│   ├── AGENTS.md                      # Global agent instructions → symlinked to ~/.pi/agent/AGENTS.md
│   ├── package/                       # NPM package: custom extensions
│   │   ├── package.json               # Deps + pi.extensions manifest
│   │   ├── package-lock.json
│   │   └── extensions/
│   │       ├── lsp/                   # LSP integration
│   │       ├── pi-rewind/             # Session rewind
│   │       ├── web-fetch.ts           # Web fetch tool
│   │       ├── web-search.ts          # Web search tool
│   │       └── ...                    # Other extensions
│   ├── skills/                        # Custom skills (SKILL.md discovery)
│   │   ├── nyaa/
│   │   ├── apkmirror-dl/
│   │   ├── buzzheavier-dl/
│   │   ├── globe-router/
│   │   └── skill-guide/               # Skill: how to create skills
│   ├── prompt-templates/              # Markdown templates (expand with /name)
│   └── themes/                        # Theme JSON files
└── package/                           # Root-level pi binary package (flake output)
```

## What lives where

| Want to change | Edit |
|---|---|
| Pi settings (provider, model, thinking level, packages) | `modules/pi/default.nix` |
| Custom models/providers | `modules/pi/models.json` |
| Extension code | `modules/pi/package/extensions/*.ts` |
| Extension dependencies | `modules/pi/package/package.json` + lockfile |
| Skills | `modules/pi/skills/<name>/SKILL.md` (+ optional scripts/) |
| Prompt templates | `modules/pi/prompt-templates/*.md` |
| Themes | `modules/pi/themes/*.json` |
| HM module wiring / npmDepsHash | `modules/pi/default.nix` |
| Global agent instructions | `modules/pi/AGENTS.md` |
| Pi binary version | `flake.nix` (piAgent flake input) |
| Private skills/extensions/prompts | `~/.pi/personal/` (not in this repo) |

## Architecture

- `default.nix` defines all pi settings inline as Nix attrsets and generates `~/.pi/agent/settings.json` from a single source.
- The module builds `package/` with `pkgs.buildNpmPackage`.
- `npmDepsHash` must be updated whenever `package/package-lock.json` changes.
- If the `piAgent` flake input exists, the module installs the `pi` binary from that flake and derives `lastChangelogVersion` from the package version.
- The generated settings inject:
  - the built extension package path
  - the local `../personal` package path, which resolves to `~/.pi/personal`
  - external extension packages (e.g. `git:github.com/tmustier/pi-extensions`)
  - the active theme (`terminal`)
  - `themes = [ "~/.pi/agent/themes" ]`

## Key rules

- **Never hand-edit `~/.pi/agent/`** — Home Manager overwrites it on rebuild. Edit `modules/pi/` only.
- All settings live in `default.nix`.
- Extensions build via `pkgs.buildNpmPackage`. Update `npmDepsHash` in `default.nix` after changing `package-lock.json`.
- Skills auto-discovered from `SKILL.md` files. Scripts go in `skills/<name>/scripts/` and get symlinked to `~/.pi/agent/bin/`.
- Prompt templates expand with `/<name>`. Keep them short, markdown format.
- `models.json` replaces the built-in model list per provider. Append to add models.

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

## Private config (~/.pi/personal)

`~/.pi/personal` is for private/internal pi stuff not meant for public sharing. Not in this repo. The generated settings reference it as a package path.

- Private skills: `~/.pi/personal/skills/`
- Private extensions: `~/.pi/personal/extensions/`
- Private prompt templates: `~/.pi/personal/prompts/`
- Private themes: `~/.pi/personal/themes/`

## Extension package

`modules/pi/package/` is a standalone pi package. Entry points declared in `package.json` under `pi.extensions`. Pi auto-discovers `extensions/`, `skills/`, `prompts/`, `themes/` when no manifest is present, but this repo uses the explicit manifest.

Adding a new extension:
1. Create `modules/pi/package/extensions/my-ext.ts`
2. Add `"./extensions/my-ext.ts"` to `pi.extensions` in `modules/pi/package/package.json`
3. Rebuild

Adding npm deps to extensions:
1. `cd modules/pi/package && npm install <dep>`
2. Note the new `npmDepsHash` (nix build will fail with the hash mismatch and show the correct one)
3. Update `npmDepsHash` in `modules/pi/default.nix`
4. Rebuild

### Adding external extension packages

Pi can load extensions from external Git repositories:

```nix
packages = [
  "${piExtensions}" 
  "../personal"
] ++ lib.optionals (builtins.pathExists /path/to/repo) [
  { source = "git:github.com/user/pi-extensions"; }
  { source = "git:github.com/user/pi-extensions"; extensions = [ "specific/ext.ts" ]; }
  { source = "git:github.com/user/pi-extensions"; skills = [ "my-skill" ]; }
];
```

Options:
- `source` — Git URL (prefixed with `git:`)
- `extensions` — load only specific extension files (array)
- `skills` — load only specific skills (array)
- No filters — loads all extensions/skills from the repo

Extension notes:
- Resources are registered in `package/package.json` under the `pi` key.
- Local extension entrypoints should stay relative to the package root, e.g. `./extensions/web-fetch.ts`.
- The module already uses this package for custom tooling like web fetch/search, LSP, notifications, and handoff helpers.

## Less obvious pi features

- `packages` accepts object filters, not just strings, if you need to narrow what a package loads.
- `enableSkillCommands` controls `/skill:name` registration.
- `npmCommand` can pin npm installs to a wrapper like `mise` or `asdf`.
- Skills can live in other harness dirs too, but this module only manages `modules/pi/skills/`.
- Prompt templates expand with `/name`.
- Pi packages can auto-discover `extensions/`, `skills/`, `prompts/`, and `themes/` when no `pi` manifest is present.

## Rebuild

```bash
# Darwin (nix-darwin)
darwin-rebuild switch --flake .

# Or via nix profile if using standalone
home-manager switch --flake .
```

After rebuild, `/reload` in pi or restart the session.
