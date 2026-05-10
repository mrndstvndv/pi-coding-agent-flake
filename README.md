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

## Update workflow

The GitHub Actions workflow in `.github/workflows/update-pi.yml`:

- checks npm daily for a new `@earendil-works/pi-coding-agent` version
- updates `package/package.json`
- regenerates `package/package-lock.json`
- recomputes `npmDepsHash`
- commits the result
