{ pkgs, lib, config, piAgent ? null, ... }:
let
  # Build the pi extensions package with its npm dependencies
  piExtensions = pkgs.buildNpmPackage {
    pname = "nixdots-pi-extensions";
    version = "1.0.0";
    src = ./package;
    npmDepsHash = "sha256-NIuEtNKdlW19WWq9bufyxJK74MqD6lvz3CS7AezIEeA=";
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
      quietStartup = true;
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

  # Pure, generated settings.json - no symlinks, no mutable state
  home.file.".pi/agent/settings.json".text = builtins.toJSON piSettingsFinal;

  # Keybindings
  home.file.".pi/agent/keybindings.json".text = builtins.toJSON {
    "app.thinking.cycle" = [ "ctrl+t" ];
    "app.thinking.toggle" = [];
  };

  # Custom provider model definitions
  home.file.".pi/agent/models.json".source = ./models.json;
}
