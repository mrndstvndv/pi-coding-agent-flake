# Code Principles

## Philosophy
Sacrifice grammar for accuracy + conciseness. Context bloat matters. Be direct.

## Rules
- Guard clauses over if-else. Early returns. Avoid nesting.
- Names reveal intent. No abbreviations.
- DRY. Extract patterns.
- Fail fast. Clear errors.
- Self-documenting code. Comments explain "why" only.

## GitHub CLI
- Search: `gh search code --repo owner/repo "query"`
- If you need to inspect a repo, clone it to ~/.pi/gh/ with --depth 1 if it doesn't already exist. Use the local clone for all subsequent searching and inspection.
- Read: `gh api -H "Accept: application/vnd.github.v3.raw" /repos/owner/repo/contents/path/to/file`

## Token Efficiency
- Batch related edits into single operations. Don't make 5 edits when 1 handles it.
- If a task needs 1 tool call, don't use 3. Plan before acting.
- Do not summarize what you just did unless the result is ambiguous or you need additional input.
