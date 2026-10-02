{
  lib,
  buildNpmPackage,
  fetchurl,
  nodejs_24,
  makeWrapper,
  piMonorepo,
}:

let
  # Upstream gitignores the generated provider catalogs; restore the exact data
  # published with pi-ai 1.0.0 instead of fetching live catalogs at build time.
  piAiDataTarball = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.0.0.tgz";
    hash = "sha256-85uZwpuFmPF1sQhA5dKoGYPnwM5crk19+DoQB0R9LCs=";
  };
in
buildNpmPackage {
  pname = "pi-durable";
  version = "1.0.0";

  src = piMonorepo;

  # Workspace monorepo: fetcher v2 caches packuments so `npm ci` can install the
  # workspace links offline.
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-wbckP8eHO2/qG8cVkNRasyceRsb0JH0i9DqlBO9FLGQ=";

  nodejs = nodejs_24;
  dontNpmBuild = true;
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ makeWrapper ];

  postPatch = ''
    tar -xzf ${piAiDataTarball} -C "$TMPDIR"
    rm -rf packages/ai/src/providers/data
    cp -r "$TMPDIR/package/dist/providers/data" packages/ai/src/providers/data
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib
    cp -r . $out/lib/pi-monorepo

    mkdir -p $out/bin
    makeWrapper ${nodejs_24}/bin/node $out/bin/pi-durable \
      --add-flags "--import $out/lib/pi-monorepo/packages/coding-agent/src/experimental/source-resolver.ts" \
      --add-flags "$out/lib/pi-monorepo/packages/coding-agent/src/experimental/durable/main.ts" \
      --run 'export PI_CODING_AGENT_DIR="''${PI_DURABLE_AGENT_DIR:-$HOME/.pi/durable/agent}"' \
      --run 'if [ ! -f "$PI_CODING_AGENT_DIR/models.json" ]; then echo "pi-durable: $PI_CODING_AGENT_DIR/models.json missing; run pi-durable-models" >&2; fi'

    makeWrapper ${nodejs_24}/bin/node $out/bin/pi-durable-models \
      --add-flags ${./pi-durable-models.mjs}

    runHook postInstall
  '';

  meta = with lib; {
    description = "Experimental durable coding agent built on @earendil-works/pi-durable";
    homepage = "https://github.com/earendil-works/pi";
    license = licenses.mit;
    mainProgram = "pi-durable";
    platforms = platforms.unix;
  };
}
