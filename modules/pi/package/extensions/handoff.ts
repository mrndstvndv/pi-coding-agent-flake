/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const AGY_COMMAND = "agy";
const AGY_PRINT_TIMEOUT = "5m";
const MAX_ERROR_OUTPUT_LENGTH = 2000;

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Do not call tools or modify files. Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

function truncateErrorOutput(output: string): string {
	const trimmed = output.trim();
	if (trimmed.length <= MAX_ERROR_OUTPUT_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_ERROR_OUTPUT_LENGTH)}...`;
}

function formatHandoffError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "Handoff failed. See logs for details.";
	}

	if (error.message === "Cancelled") return "Cancelled";

	const message = error.message.toLowerCase();
	if (message.includes("spawn agy enoent")) {
		return "Antigravity CLI not found. Install it and ensure `agy` is on PATH.";
	}
	if (message.includes("authentication required") || message.includes("not authenticated")) {
		return "Antigravity CLI is not authenticated. Run `agy` interactively once, then retry.";
	}
	if (message.includes("quota")) {
		return "Antigravity quota exceeded. Try again later or select another model.";
	}

	return `Antigravity CLI failed: ${truncateErrorOutput(error.message)}`;
}

function runAgyPrompt(
	prompt: string,
	cwd: string,
	signal: AbortSignal,
	onOutput: (output: string) => void,
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Cancelled"));
			return;
		}

		const child = spawn(
			AGY_COMMAND,
			["--print", prompt, "--output-format", "text", "--print-timeout", AGY_PRINT_TIMEOUT],
			{ cwd, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		let diagnostics = "";
		let aborted = false;
		let settled = false;
		let killTimeout: ReturnType<typeof setTimeout> | undefined;

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, 5000);
		};

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (killTimeout) clearTimeout(killTimeout);
		};

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			output += chunk.toString();
			onOutput(output);
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			diagnostics += chunk.toString();
		});

		child.once("error", (error) => {
			finish(() => reject(aborted ? new Error("Cancelled") : error));
		});

		child.once("close", (code, signalName) => {
			finish(() => {
				if (aborted) {
					reject(new Error("Cancelled"));
					return;
				}

				if (code !== 0) {
					const details = truncateErrorOutput(diagnostics);
					const suffix = details ? `: ${details}` : "";
					reject(new Error(`agy exited with ${code === null ? signalName ?? "an unknown status" : `code ${code}`}${suffix}`));
					return;
				}

				const response = output.trim();
				if (!response) {
					reject(new Error("agy returned an empty response"));
					return;
				}

				resolve(response);
			});
		});

		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

/** Update loader message by accessing internal component */
function updateLoaderMessage(loader: BorderedLoader, message: string): void {
	// BorderedLoader doesn't expose setMessage, so we use type assertion
	// to access the internal Loader component
	const internal = loader as unknown as { loader: { setMessage: (m: string) => void } };
	internal.loader?.setMessage(message);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			let lastError: string | null = null;

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handoff prompt with Antigravity...");
				const abortController = new AbortController();
				loader.onAbort = () => {
					abortController.abort();
					done(null);
				};

				const updateMessage = (msg: string) => {
					updateLoaderMessage(loader, msg);
					tui.requestRender();
				};

				const doGenerate = async (): Promise<string | null> => {
					const combinedPrompt = `${SYSTEM_PROMPT}\n\n## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`;

					updateMessage("Running Antigravity...");
					const finalText = await runAgyPrompt(
						combinedPrompt,
						ctx.sessionManager.cwd,
						abortController.signal,
						(output) => {
							const preview = output.slice(-150).replace(/\s+/g, " ").trim();
							if (preview) updateMessage(preview);
						},
					);

					if (abortController.signal.aborted) return null;
					return finalText;
				};

				doGenerate()
					.then((generatedPrompt) => {
						if (!abortController.signal.aborted) done(generatedPrompt);
					})
					.catch((error: unknown) => {
						if (abortController.signal.aborted) return;
						lastError = formatHandoffError(error);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify(lastError ?? "Cancelled", lastError ? "error" : "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});
			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
