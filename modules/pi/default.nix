{ pkgs, lib, config, piAgent ? null, ... }:
let
  # Build the pi extensions package with its npm dependencies
  piExtensions = pkgs.buildNpmPackage {
    pname = "nixdots-pi-extensions";
    version = "1.0.0";
    src = ./package;
    npmDepsHash = "sha256-OvZVykj89gIAc/ANUOJRJmBuP7kzCPlQSRgaEJheYRg=";
    buildPhase = "true";
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
  };

  piPackageDefault = lib.attrByPath [ "packages" pkgs.system "default" ] null piAgent;
  piPackageNamed = lib.attrByPath [ "packages" pkgs.system "pi" ] null piAgent;
  piPackage =
    if piAgent == null then null
    else if piPackageDefault != null then piPackageDefault
    else if piPackageNamed != null then piPackageNamed
    else throw "piAgent flake must expose packages.${pkgs.system}.default or packages.${pkgs.system}.pi";

  piVersion =
    if piPackage == null then null
    else if piPackage ? version then piPackage.version
    else if lib.hasAttrByPath [ "lib" "version" ] piAgent then piAgent.lib.version
    else throw "piAgent flake must expose a pi package version via packages.${pkgs.system}.*.version or lib.version";
  piSettingsFinal =
    {
      lsp.hookMode = "edit_write";
      defaultProvider = "opencode";
      defaultModel = "deepseek-v4-flash-free";
      defaultThinkingLevel = "xhigh";
      hideThinkingBlock = true;
      showCacheMissNotices = true;
      quietStartup = true;
      showHardwareCursor = true;
    }
    // lib.optionalAttrs (piVersion != null) { lastChangelogVersion = piVersion; }
    // {
      packages =
        [ "${piExtensions}" "../personal" "npm:@ff-labs/pi-fff" ];
      theme = "terminal";
      themes = [ "~/.pi/agent/themes" ];
    };
in
{
  home.packages = with pkgs; [
    ddgr
  ] ++ lib.optionals (piPackage != null) [
    piPackage
  ];

  home.file.".pi/agent/AGENTS.md".source = ./AGENTS.md;

  # Skills - symlink entire directory
  home.file.".pi/agent/skills".source = ./skills;

  # Themes - symlink entire directory
  home.file.".pi/agent/themes".source = ./themes;

  # Prompt templates - symlink to ~/.pi/agent/prompts/
  home.file.".pi/agent/prompts".source = ./prompt-templates;

  # Keybindings
  home.file.".pi/agent/keybindings.json".text = builtins.toJSON {
    "app.thinking.cycle" = [ "ctrl+t" ];
    "app.thinking.toggle" = [];
  };

  # Custom provider model definitions
  home.file.".pi/agent/models.json".source = ./models.json;

  # settings.json must stay writable (pi persists /setting changes there).
  # It can't be a home.file: that deploys a read-only store symlink, and once
  # materialized as a regular file, HM's checkLinkTargets collision check
  # (with backupFileExtension set) hard-fails on every rebuild. Generate it
  # purely in activation, outside HM's file management. Declarative content
  # wins on rebuild; hand edits survive until the next switch.
  home.activation.makePiSettingsWritable = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD install -m 0644 "${pkgs.writeText "pi-settings.json" (builtins.toJSON piSettingsFinal)}" "$HOME/.pi/agent/.settings.json.tmp"
    $DRY_RUN_CMD mv -f "$HOME/.pi/agent/.settings.json.tmp" "$HOME/.pi/agent/settings.json"
  '';
}
