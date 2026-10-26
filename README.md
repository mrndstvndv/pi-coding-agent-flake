# pi-coding-agent flake

Standalone flake packaging `@earendil-works/pi-coding-agent` as a Nix package and Home Manager module.

## Outputs

- `packages.${system}.pi`
- `homeManagerModules.default`
- `lib.version`

## Local usage

```nix
piAgent.url = "path:./pkgs/pi-coding-agent-flake";
piAgent.inputs.nixpkgs.follows = "nixpkgs";
```

Import the Home Manager module from this flake:

```nix
imports = [ inputs.piAgent.homeManagerModules.default ];
```

## Main-screen resize policy

The packaged CLI enables `PI_TUI_INCREMENTAL_HEIGHT_RESIZE=1`. Height-only changes
(such as an Android keyboard opening through Rex) use Pi's existing incremental
resize path instead of clearing scrollback and replaying the full conversation and
Kitty image payloads. Width changes still redraw because line wrapping changes.

Set `PI_TUI_INCREMENTAL_HEIGHT_RESIZE=0` to restore upstream height-redraw behavior.
The build tests long-history/image resizing and patches both the CLI bundle and the
standalone `pi-tui` renderer, failing if upstream markers change. Existing running
Pi processes must be restarted after installing the rebuilt package; `/reload`
does not replace the renderer code.

## Update workflow

The GitHub Actions workflow in `.github/workflows/update-pi.yml`:

- checks npm daily for a new `@earendil-works/pi-coding-agent` version
- updates `package/package.json`
- regenerates `package/package-lock.json`
- recomputes `npmDepsHash`
- commits the result
