# Antigravity CLI headless mode

## Finding

Antigravity CLI supports non-interactive (headless/print) runs. Pass one prompt with `-p`, `--print`, or `--prompt`; it runs once, prints the response, and exits.

```bash
agy -p "In one sentence, explain git rebase"
```

The response is written to `stdout`; diagnostics, authentication messages, progress, and permission notices are written to `stderr`.

## Output modes

- `--output-format text` (default): raw response text
- `--output-format json`: one result envelope containing `response`, status, conversation ID, duration, and usage
- `--output-format stream-json`: newline-delimited events for streaming responses and tool progress

Structured output can be requested with `--json-schema`.

## Operational notes

- Authenticate once with an interactive `agy` session; headless mode uses cached credentials.
- Default timeout is five minutes; adjust with `--print-timeout`.
- Headless mode has no approval prompt. Tool permissions come from configured policy; `--dangerously-skip-permissions` approves everything and should not be used casually.
- Runs are stateless by default. `--continue` or `--conversation <id>` resumes prior context.

## Sources

- Official headless-mode documentation: https://antigravity.google/docs/cli/headless
- Official CLI overview: https://antigravity.google/docs/cli/overview
- Official CLI repository: https://github.com/google-antigravity/antigravity-cli
