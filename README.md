# pi-coding-agent flake

Standalone flake packaging `@mariozechner/pi-coding-agent` as a Nix package and app.

## Outputs

- `packages.${system}.default`
- `packages.${system}.pi`
- `apps.${system}.default`
- `lib.version`

## Local usage

```nix
piAgent.url = "path:./pkgs/pi-coding-agent-flake";
piAgent.inputs.nixpkgs.follows = "nixpkgs";
```

## Update workflow

The GitHub Actions workflow in `.github/workflows/update-pi.yml`:

- checks npm daily for a new `@mariozechner/pi-coding-agent` version
- updates `package/package.json`
- regenerates `package/package-lock.json`
- recomputes `npmDepsHash`
- commits the result
