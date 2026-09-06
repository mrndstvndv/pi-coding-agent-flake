# Pi `apply_patch` extension research

## Finding

There are third-party Pi extensions for the Codex/OpenAI patch workflow. The strongest current match is [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch), version `0.1.2` in its package manifest. It is also tracked as the `gpt-apply-patch` external extension in the [`senpi` repository](https://github.com/code-yeongyu/senpi/blob/main/packages/coding-agent/src/core/extensions/builtin/external-versions.json).

Pi's upstream built-in file tools remain `read`, `write`, `edit`, and `bash`; the built-in `edit` tool uses a path plus exact `oldText`/`newText` replacements. Pi extensions can register tools and change the active tool set through [`registerTool()` and `setActiveTools()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Recommended extension's tool contract

The extension registers one model-facing tool named `apply_patch` with this JSON fallback schema:

```json
{
  "input": "*** Begin Patch\n...\n*** End Patch"
}
```

`input` is the only required property and is a string containing the entire patch. The extension also accepts a raw string when Pi invokes its freeform grammar mode. On grammar-capable OpenAI models, Pi receives the patch as an OpenAI custom grammar tool; other compatible models use the function-tool fallback with the same `input` string.

The patch envelope is Codex/V4A style:

```text
*** Begin Patch
*** Add File: path/to/new-file
+line of initial content
*** Update File: path/to/existing-file
@@ optional context label
 context line
-old line
+new line
*** Move to: path/to/renamed-file
*** Delete File: path/to/obsolete-file
*** End Patch
```

Supported operations are add, update, delete, and update-plus-move. Add-file content lines start with `+`; update hunks use `@@`, context lines beginning with a space, removed lines beginning with `-`, and added lines beginning with `+`. The official OpenAI Agents SDK documents the corresponding operation union as `create_file`, `update_file` (with optional `moveTo`), and `delete_file`: [`ApplyPatchOperation`](https://openai.github.io/openai-agents-js/openai/agents/type-aliases/applypatchoperation-1/). OpenAI's Codex repository publishes the patch grammar and usage instructions [here](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/apply_patch_tool_instructions.md).

## Model selection behavior

`pi-apply-patch` registers the tool at load time and synchronizes the tool set on session start, model selection, and before-agent-start. For GPT model IDs routed through the providers `openai`, `openai-codex`, `azure-openai-responses`, or `github-copilot`, or through the APIs `openai-responses` and `openai-codex-responses`, it removes `edit` and `write` and adds `apply_patch`. For other models it restores `edit` and `write`.

That matches this flake's `openai-codex` models whose IDs begin with `gpt-`. It may also match GitHub Copilot GPT models. The extension's peer dependencies target the current `@earendil-works/pi-*` package names, but compatibility with this checkout's pinned Pi `0.85.1` should still be tested before pinning it into the Nix build.

## Safety and maintenance notes

The current extension intentionally resolves paths with `path.resolve(cwd, filePath)`, and its README says absolute or parent-escaping paths are accepted. This means the extension can mutate files outside the current project. Review or fork it to enforce a workspace-relative path policy if that is not desired.

An older alternative is [`gturkoglu/pi-codex-apply-patch`](https://github.com/gturkoglu/pi-codex-apply-patch). It uses a JSON schema with an `operations` array, where each item has `type`, `path`, and an optional `diff`/`move_path`, and it validates paths against directory traversal. Its source imports older `@mariozechner/*` package names, so it is less suitable for this checkout without a port.

## Installation reference

The current extension documents these Pi package commands:

```bash
pi install git:github.com/code-yeongyu/pi-apply-patch
```

It can also be loaded with `pi -e /path/to/pi-apply-patch/src/index.ts`. In this flake, a package object with `source = "git:github.com/code-yeongyu/pi-apply-patch"` would fit the existing declarative `packages` list; run `/reload` after rebuilding.

## Sources

- [`pi-apply-patch` README](https://github.com/code-yeongyu/pi-apply-patch/blob/main/README.md)
- [`pi-apply-patch` implementation](https://raw.githubusercontent.com/code-yeongyu/pi-apply-patch/main/src/index.ts)
- [`pi-apply-patch` package manifest](https://raw.githubusercontent.com/code-yeongyu/pi-apply-patch/main/package.json)
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi built-in `edit` implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [OpenAI Agents SDK `ApplyPatchOperation`](https://openai.github.io/openai-agents-js/openai/agents/type-aliases/applypatchoperation-1/)
- [OpenAI Codex patch grammar](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/apply_patch_tool_instructions.md)
