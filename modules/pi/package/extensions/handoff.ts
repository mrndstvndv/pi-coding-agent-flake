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

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { createAcpPool, type AcpPool } from "./acp-client.js";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

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

/** Global ACP pool - shared across all handoff calls for this pi instance */
let acpPool: AcpPool | null = null;

/** Map of auth method aliases to ACP protocol auth method IDs for Gemini */
function getGeminiAuthMethod(hasApiKey: boolean): string {
	return hasApiKey ? "gemini-api-key" : "oauth-personal";
}

/** Get or create the global ACP pool */
function getAcpPool(cwd: string): AcpPool {
	if (!acpPool) {
		const hasApiKey = !!process.env.GEMINI_API_KEY;
		acpPool = createAcpPool({
			cwd,
			command: "gemini",
			// Prefer Flash at process startup. We'll also set the ACP session model when supported.
			args: ["--model", HANDOFF_MODEL, "--acp"],
			authMethod: getGeminiAuthMethod(hasApiKey),
			env: {
				GEMINI_CLI_DISABLE_SESSION_PERSISTENCE: "true",
			},
		});

		process.on("beforeExit", () => {
			acpPool?.shutdown().catch(() => {});
		});
	}
	return acpPool;
}

const HANDOFF_MODEL = "gemini-3-flash-preview";

function findModelConfigId(
	configOptions: Array<{ id: string; category?: string | null }>
): string | null {
	const modelOption = configOptions.find((option) => option.category === "model");
	if (modelOption) return modelOption.id;

	const fallback = configOptions.find((option) => option.id === "model");
	return fallback?.id ?? null;
}

function formatHandoffError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "Handoff failed. See logs for details.";
	}

	const message = error.message.toLowerCase();
	if (message.includes("exhausted your daily quota")) {
		return "Gemini quota exceeded for the current model. Try again later, switch models, or use a different API key.";
	}
	if (message.includes("api key is missing")) {
		return "Gemini API key not configured. Set GEMINI_API_KEY or run 'gemini auth login'.";
	}
	if (message.includes("chat not initialized")) {
		return "Gemini session failed to initialize. Try again or restart pi.";
	}

	return error.message;
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
			const pool = getAcpPool(ctx.sessionManager.cwd);

			let lastError: string | null = null;

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const initialMessage = pool.isFirstUse
					? "Connecting to Gemini..."
					: "Generating handoff prompt...";

				const loader = new BorderedLoader(tui, theme, initialMessage);
				loader.onAbort = () => done(null);

				const updateMessage = (msg: string) => {
					updateLoaderMessage(loader, msg);
					tui.requestRender();
				};

				const doGenerate = async () => {
					const combinedPrompt = `${SYSTEM_PROMPT}\n\n## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`;

					updateMessage("Creating session...");
					const session = await pool.newSession();

					if (loader.signal?.aborted) {
						session.dispose();
						return null;
					}

					try {
						const modelConfigId = findModelConfigId(session.configOptions);
						if (modelConfigId) {
							const flashOption = session.configOptions
								.find((option) => option.id === modelConfigId)
								?.options.find((option) => option.value === HANDOFF_MODEL);

							if (flashOption) {
								updateMessage("Selecting model...");
								await session.setConfigOption(modelConfigId, HANDOFF_MODEL);
							}
						}

						updateMessage("Generating...");
						
						// Stream text chunks to update the loader in real-time
						let streamedText = "";
						const promptResult = await session.prompt(
							[{ type: "text", text: combinedPrompt }],
							(chunk) => {
								streamedText = chunk;
								// Show last ~150 chars for real-time feedback
								const preview = chunk.slice(-150).replace(/\s+/g, " ").trim();
								if (preview) updateMessage(preview);
							}
						);

						if (promptResult.stopReason === "error") {
							throw new Error("Generation failed - the model may be unavailable or quota exceeded");
						}

						const finalText = promptResult.text || streamedText;
						if (!finalText?.trim()) {
							throw new Error("Empty response from Gemini - session may need authentication");
						}

						return finalText;
					} finally {
						session.dispose();
					}
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						lastError = formatHandoffError(err);
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

			const newSessionResult = await ctx.newSession({ parentSession: currentSessionFile });
			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});
}
