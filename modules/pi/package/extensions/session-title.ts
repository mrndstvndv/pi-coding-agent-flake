import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

const AGY_COMMAND = "agy";
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

	return error.message;
}

async function generateTitle(pi: ExtensionAPI, ctx: TitleContext): Promise<string> {
	const conversationContext = buildConversationContext(ctx.sessionManager.getBranch());
	if (!conversationContext) throw new Error("no user or assistant messages found in this session");

	const result = await pi.exec(
		AGY_COMMAND,
		[
			"--print",
			buildTitlePrompt(conversationContext),
			"--output-format",
			"text",
			"--print-timeout",
			AGY_PRINT_TIMEOUT,
		],
		{ cwd: ctx.cwd, timeout: AGY_TIMEOUT_MS },
	);

	if (result.code !== 0) {
		throw new Error(formatCommandError(result));
	}

	return normalizeTitle(result.stdout);
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
				ctx.ui.notify(`Title generation failed: ${message}`, "warning");
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
