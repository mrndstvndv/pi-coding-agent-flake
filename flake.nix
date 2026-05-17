{
  description = "pi coding agent CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
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
      npmDepsHash = "sha256-9EVXYZ5HEOxiCQxNQ7M2Nj9heiomQHWrQzoA6draYeY=";

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
          installPhase = ''
            runHook preInstall

            mkdir -p $out/bin $out/lib
            cp -r node_modules $out/lib/
            cp package.json package-lock.json $out/lib/

            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/pi \
              --add-flags "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
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
    in
    {
      lib = {
        inherit version;
      };

      homeManagerModules.default = import ./modules/pi/default.nix;

      packages = forAllSystems (system: {
        default = mkPi system;
        pi = mkPi system;
      });
    };
}
