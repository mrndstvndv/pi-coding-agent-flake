import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGY_COMMAND = "agy";
const AGY_MODEL = "gpt-oss-120b-medium";
const AGY_TIMEOUT_MS = 90_000;
const AGY_PRINT_TIMEOUT = "90s";
const MAX_SOURCE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 80;

const TITLE_PROMPT = `Generate a concise title for this coding-agent session.

Rules:
- Return only the title text.
- Use 3 to 8 words.
- Keep it under 80 characters.
- Do not use quotes, Markdown, a title prefix, or trailing punctuation.
- Capture the user's main task, not implementation details.
- Do not call tools or modify files.

<conversation>
{{CONVERSATION_CONTEXT}}
</conversation>`;

type TitleContext = Pick<ExtensionContext, "cwd" | "hasUI" | "sessionManager" | "ui">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type !== "text" || typeof part.text !== "string") continue;
		parts.push(part.text);
	}

	return parts.join("\n").trim();
}

function buildConversationContext(entries: SessionEntry[]): string | null {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;

		const text = extractText(entry.message.content);
		if (!text) continue;

		const role = entry.message.role === "user" ? "User" : "Assistant";
		sections.push(`${role}: ${text}`);
	}

	const context = sections.join("\n\n").trim();
	return context || null;
}

function buildTitlePrompt(conversationContext: string): string {
	const source = conversationContext.slice(0, MAX_SOURCE_LENGTH);
	return TITLE_PROMPT.replace("{{CONVERSATION_CONTEXT}}", source);
}

function formatCommandError(result: { code: number; stderr: string; killed: boolean }): string {
	const diagnostics = result.stderr.trim();
	if (diagnostics) return diagnostics;
	if (result.killed) return "agy was terminated before returning a title";
	return `agy exited with code ${result.code}`;
}

function normalizeTitle(value: string): string {
	const firstLine = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean)
		?.replace(/^(?:title|session title)\s*:\s*/i, "")
		.replace(/^[`"'*]+|[`"'*]+$/g, "")
		.trim();

	if (!firstLine) throw new Error("agy returned an empty title");
	if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;

	return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function formatError(error: unknown): string {
	if (!(error instanceof Error)) return "unknown error";

	const message = error.message.toLowerCase();
	if (message.includes("spawn agy enoent")) {
		return "Antigravity CLI not found on PATH";
	}
	if (message.includes("authentication required") || message.includes("not authenticated")) {
		return "Antigravity CLI is not authenticated; run `agy` interactively once";
	}
	if (message.includes("quota")) {
		return "Antigravity quota exceeded; try again later";
	}

	return error.message;
}

function agyDir(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

interface PointerState {
	cwds: string[];
	prevValues: Map<string, unknown>;
}

function readPointerState(cwd: string): PointerState {
	const cwds = [cwd];
	try {
		const real = fs.realpathSync(cwd);
		if (real !== cwd) cwds.push(real);
	} catch {
		// cwd may not exist or cannot be resolved, fallback to ctx.cwd
	}

	const prevValues = new Map<string, unknown>();
	try {
		const ptrFile = path.join(agyDir(), "cache", "last_conversations.json");
		if (fs.existsSync(ptrFile)) {
			const parsed: unknown = JSON.parse(fs.readFileSync(ptrFile, "utf8"));
			if (isRecord(parsed)) {
				for (const c of cwds) {
					if (c in parsed) {
						prevValues.set(c, parsed[c]);
					}
				}
			}
		}
	} catch (error) {
		console.warn(`[session-title] failed to read continue pointer: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { cwds, prevValues };
}

function restorePointerState(state: PointerState, conversationId?: string): void {
	try {
		const cacheDir = path.join(agyDir(), "cache");
		const ptrFile = path.join(cacheDir, "last_conversations.json");
		if (!fs.existsSync(ptrFile)) return;

		const parsed: unknown = JSON.parse(fs.readFileSync(ptrFile, "utf8"));
		if (!isRecord(parsed)) return;

		let changed = false;
		for (const cwd of state.cwds) {
			const currentVal = parsed[cwd];
			// Only restore if this run set the pointer, or if no conversationId was known
			if (conversationId && currentVal !== conversationId) continue;

			if (state.prevValues.has(cwd)) {
				const prev = state.prevValues.get(cwd);
				if (parsed[cwd] !== prev) {
					parsed[cwd] = prev;
					changed = true;
				}
			} else if (cwd in parsed) {
				delete parsed[cwd];
				changed = true;
			}
		}

		if (changed) {
			const tmp = path.join(
				cacheDir,
				`last_conversations.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
			);
			fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
			fs.renameSync(tmp, ptrFile);
		}
	} catch (error) {
		console.warn(`[session-title] failed to restore continue pointer: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Clean up the per-conversation ephemeral files created on disk for this run.
function cleanupAgyConversation(conversationId: string): void {
	if (!/^[0-9a-fA-F-]{8,64}$/.test(conversationId)) return;
	const base = agyDir();
	const rm = (rel: string) => {
		try {
			fs.rmSync(path.join(base, rel), { recursive: true, force: true });
		} catch (error) {
			console.warn(`[session-title] failed to clean up ephemeral file ${rel}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	rm(`conversations/${conversationId}.db`);
	rm(`conversations/${conversationId}.db-wal`);
	rm(`conversations/${conversationId}.db-shm`);
	rm(`brain/${conversationId}`);
	rm(`presence/${conversationId}.lock`);
	rm(`annotations/${conversationId}.pbtxt`);
}

interface ParsedAgyOutput {
	response?: string;
	conversationId?: string;
	parseError?: Error;
}

function parseAgyJsonOutput(stdout: string): ParsedAgyOutput {
	let parsed: unknown;
	let parseError: Error | undefined;
	const trimmed = stdout.trim();
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		parseError = error instanceof Error ? error : new Error(String(error));
		// Fallback: extract JSON object substring if agy printed surrounding output/warnings
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				parsed = JSON.parse(match[0]);
				parseError = undefined;
			} catch (subError) {
				parseError = subError instanceof Error ? subError : new Error(String(subError));
				return { parseError };
			}
		} else {
			return { parseError };
		}
	}

	if (!isRecord(parsed)) return { parseError: parseError ?? new Error("output is not a JSON object") };

	const conversationId =
		typeof parsed.conversation_id === "string" && /^[0-9a-fA-F-]{8,64}$/.test(parsed.conversation_id)
			? parsed.conversation_id
			: undefined;
	const response = typeof parsed.response === "string" ? parsed.response : undefined;

	return { response, conversationId };
}

async function generateTitle(pi: ExtensionAPI, ctx: TitleContext): Promise<string> {
	const conversationContext = buildConversationContext(ctx.sessionManager.getBranch());
	if (!conversationContext) throw new Error("no user or assistant messages found in this session");

	const pointerState = readPointerState(ctx.cwd);
	let conversationId: string | undefined;

	try {
		const result = await pi.exec(
			AGY_COMMAND,
			[
				"--model",
				AGY_MODEL,
				"--print",
				buildTitlePrompt(conversationContext),
				"--output-format",
				"json",
				"--print-timeout",
				AGY_PRINT_TIMEOUT,
			],
			{ cwd: ctx.cwd, timeout: AGY_TIMEOUT_MS },
		);

		const parsed = parseAgyJsonOutput(result.stdout);
		conversationId = parsed.conversationId;

		if (result.code !== 0) {
			throw new Error(formatCommandError(result));
		}

		if (!parsed.response) {
			const reason = parsed.parseError ? ` (${parsed.parseError.message})` : "";
			const snippet = result.stdout.trim().slice(0, 200);
			throw new Error(snippet ? `agy returned unexpected JSON${reason}: ${snippet}` : "agy returned an empty response");
		}

		return normalizeTitle(parsed.response);
	} finally {
		if (conversationId) {
			cleanupAgyConversation(conversationId);
		}
		restorePointerState(pointerState, conversationId);
	}
}

export default function sessionTitleExtension(pi: ExtensionAPI): void {
	let automaticAttempted = false;
	let generationInFlight = false;

	pi.on("session_start", () => {
		automaticAttempted = Boolean(pi.getSessionName());
		generationInFlight = false;
	});

	async function setTitle(ctx: TitleContext, notifyOnFailure: boolean): Promise<void> {
		if (ctx.hasUI) {
			ctx.ui.setStatus("title", "Generating session title…");
		}
		try {
			const title = await generateTitle(pi, ctx);
			pi.setSessionName(title);
			if (notifyOnFailure && ctx.hasUI) {
				ctx.ui.notify(`Session titled: ${title}`, "info");
			}
		} catch (error) {
			const message = formatError(error);
			if (notifyOnFailure && ctx.hasUI) {
				ctx.ui.notify(`Title generation failed: ${message}`, "error");
				return;
			}
			console.error(`[session-title] ${message}`);
		} finally {
			if (ctx.hasUI) {
				ctx.ui.setStatus("title", undefined);
			}
		}
	}

	pi.on("agent_settled", (_event, ctx) => {
		if (automaticAttempted || generationInFlight || pi.getSessionName()) return;

		automaticAttempted = true;
		generationInFlight = true;
		// Fire-and-forget: awaiting agy (up to 90s) inside an agent_settled handler
		// would keep the session from settling, blocking new prompts until it returns.
		void setTitle(ctx, false).finally(() => {
			generationInFlight = false;
		});
	});

	pi.registerCommand("title", {
		description: "Generate or regenerate the current session title with Antigravity",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (generationInFlight) {
				ctx.ui.notify("Title generation is already running", "warning");
				return;
			}

			generationInFlight = true;
			try {
				await setTitle(ctx, true);
			} finally {
				generationInFlight = false;
			}
		},
	});
}
