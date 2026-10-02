{
  description = "pi coding agent CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Pinned Pi monorepo source for the experimental durable coding agent.
    piMonorepo = {
      url = "github:earendil-works/pi/v1.0.0";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, piMonorepo }:
    let
      lib = nixpkgs.lib;
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      packageManifest = builtins.fromJSON (builtins.readFile ./package/package.json);
      version = packageManifest.dependencies."@earendil-works/pi-coding-agent";
      npmDepsHash = "sha256-tXGvzZL1rgEXUvJKghmMtfNSLYxPfxBuRDcwDJmt0W0=";

      mkPi = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.buildNpmPackage {
          pname = "pi-coding-agent";
          inherit version npmDepsHash;
          src = ./package;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontNpmBuild = true;
          makeCacheWritable = true;
          installPhase = ''
            runHook preInstall

            ${pkgs.nodejs_24}/bin/node patch-footer.mjs
            ${pkgs.nodejs_24}/bin/node patch-alt-scroll.mjs

            mkdir -p $out/bin $out/lib
            cp -r node_modules $out/lib/
            cp package.json package-lock.json $out/lib/

            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/pi \
              --add-flags "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
              --set-default PI_PACKAGE_DIR "$out/lib/node_modules/@earendil-works/pi-coding-agent"

            runHook postInstall
          '';
          meta = with pkgs.lib; {
            description = "pi coding agent CLI";
            homepage = "https://github.com/earendil-works/pi-mono";
            license = licenses.mit;
            mainProgram = "pi";
            platforms = platforms.unix;
          };
        };
      mkPiDurable = system:
        nixpkgs.legacyPackages.${system}.callPackage ./pkgs/pi-durable.nix {
          inherit piMonorepo;
        };
    in
    {
      lib = {
        inherit version;
      };

      # Inject the durable package built with this flake's pinned nixpkgs and
      # monorepo source, so consumers don't need extra inputs and the pinned
      # npmDepsHash always matches the toolchain that builds it.
      homeManagerModules.default = { pkgs, ... }: {
        imports = [ ./modules/pi/default.nix ];
        _module.args.piDurable = mkPiDurable pkgs.stdenv.hostPlatform.system;
      };

      packages = forAllSystems (system: {
        default = mkPi system;
        pi = mkPi system;
        pi-durable = mkPiDurable system;
      });
    };
}
