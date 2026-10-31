{ pkgs, lib, config, piAgent ? null, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;

  # Build the pi extensions package with its npm dependencies
  piExtensions = pkgs.buildNpmPackage {
    pname = "nixdots-pi-extensions";
    version = "1.0.0";
    src = ./package;
    npmDepsHash = "sha256-SZNBXCcXYatg71HOd64X3ASlytae6yBkeFUPbJtu/Kc=";
    buildPhase = "true";
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
  };

  piPackageDefault = lib.attrByPath [ "packages" system "default" ] null piAgent;
  piPackageNamed = lib.attrByPath [ "packages" system "pi" ] null piAgent;
  piPackage =
    if piAgent == null then null
    else if piPackageDefault != null then piPackageDefault
    else if piPackageNamed != null then piPackageNamed
    else throw "piAgent flake must expose packages.${system}.default or packages.${system}.pi";

  piVersion =
    if piPackage == null then null
    else if piPackage ? version then piPackage.version
    else if lib.hasAttrByPath [ "lib" "version" ] piAgent then piAgent.lib.version
    else throw "piAgent flake must expose a pi package version via packages.${system}.*.version or lib.version";

  # Radius MCP replaces the deprecated npm:@earendil-works/pi-radius
  # extensions. `auth.provider` reuses the radius credential from auth.json.
  piMcpFinal = {
    mcpServers.radius = {
      url = "https://radius.pi.dev/mcp";
      auth.provider = "radius";
    };
    mcpServers.superlogical.url = "https://www.superlogical.com/rex/community-mcp";
  };
  piSettingsFinal =
    {
      lsp.hookMode = "edit_write";
      defaultProvider = "openai-codex";
      defaultModel = "gpt-6-luna";
      defaultThinkingLevel = "xhigh";
      hideThinkingBlock = true;
      # Add codemode on top of the defaults (read/bash/edit/write) so the
      # model can run JS in a QuickJS sandbox that calls tools in parallel.
      defaultTools = [ "+codemode" ];
      showCacheMissNotices = true;
      quietStartup = true;
      showHardwareCursor = false;
      tuiMode = "regular";
    }
    // lib.optionalAttrs (piVersion != null) { lastChangelogVersion = piVersion; }
    // {
      packages = [
        "${piExtensions}"
        "../personal"
      ];
      theme = "terminal";
      themes = [ "~/.pi/agent/themes" ];
      modelThinkingLevels = {
        "openai-codex/gpt-5.6-luna" = "max";
        "github-copilot/gpt-5.6-luna" = "max";
        "openai-codex/gpt-5.6-sol" = "high";
        "opencode/mimo-v2.6-flash-free" = "xhigh";
        "openai-codex/gpt-6-luna" = "max";
        "openai-codex/gpt-6-sol" = "medium";
        "openai-codex/gpt-6.1-sol" = "low";
      };
    };
in
{
  home.packages = lib.optionals (piPackage != null) [ piPackage ];

  home.file.".pi/agent/AGENTS.md".source = ./AGENTS.md;
  home.file.".pi/agent/models.json".source = ./models.json;

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

  # mcp.json stays writable like settings.json: declarative servers win on
  # rebuild, while `pi mcp add` and /login edits survive until the next switch.
  home.activation.makePiMcpWritable = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD install -m 0600 "${pkgs.writeText "pi-mcp.json" (builtins.toJSON piMcpFinal)}" "$HOME/.pi/agent/.mcp.json.tmp"
    $DRY_RUN_CMD mv -f "$HOME/.pi/agent/.mcp.json.tmp" "$HOME/.pi/agent/mcp.json"
  '';

}
