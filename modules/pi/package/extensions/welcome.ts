import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { basename, parse } from "node:path";

const WIDGET_KEY = "recent-sessions";
const MAX_SESSIONS = 5;

type SessionInfo = Awaited<ReturnType<typeof SessionManager.list>>[number];

type WidgetPlacement = "aboveEditor" | "belowEditor";

interface WelcomeUi {
	setWidget(
		key: string,
		content:
			| string[]
			| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
			| undefined,
		options?: { placement?: WidgetPlacement },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	setEditorText(text: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface WelcomeSessionManager {
	getEntries(): { type: string }[];
	getSessionDir(): string;
}

interface WelcomeContext {
	hasUI: boolean;
	cwd: string;
	sessionManager: WelcomeSessionManager;
	ui: WelcomeUi;
}

let welcomeWidget: RecentSessionsWidget | undefined;
let terminalInputUnsubscribe: (() => void) | undefined;
let recentSessions: SessionInfo[] = [];
let recentSessionsLoaded = false;
let sessionPickerEnabled = false;
let openedSessionSequence = 0;
const openedSessions = new Map<string, number>();

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 60_000) return "now";

	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;

	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks}w ago`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;

	return `${Math.floor(days / 365)}y ago`;
}

function normalizeText(text: string | undefined): string {
	const value = text?.trim();
	if (!value) return "Untitled session";
	return value.replace(/\s+/g, " ");
}

function shortCwd(cwd: string): string {
	const name = basename(cwd);
	if (name) return name;

	const root = parse(cwd).root;
	if (root) return root;

	return ".";
}

function buildSessionPreview(session: SessionInfo): string {
	const prompt = normalizeText(session.firstMessage);
	if (session.name) {
		return `${normalizeText(session.name)} — ${prompt}`;
	}

	return prompt;
}

function markSessionOpened(sessionPath: string | undefined): void {
	if (!sessionPath) return;

	openedSessions.set(sessionPath, ++openedSessionSequence);
}

function sortSessionsByMostRecentlyOpened(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => {
		const openedDifference = (openedSessions.get(b.path) ?? 0) - (openedSessions.get(a.path) ?? 0);
		if (openedDifference !== 0) return openedDifference;

		return b.modified.getTime() - a.modified.getTime();
	});
}

class RecentSessionsWidget implements Component {
	private loading = true;
	private error: string | null = null;
	private sessions: SessionInfo[] = [];
	private selectedIndex = 0;
	private pickerEnabled = false;
	private disposed = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly sessionDir: string,
	) {
		void this.load();
	}

	setPickerEnabled(enabled: boolean): void {
		if (this.pickerEnabled === enabled) return;
		this.pickerEnabled = enabled;
		if (!enabled) {
			this.selectedIndex = 0;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private async load(): Promise<void> {
		try {
			const sessions = await SessionManager.list(this.cwd, this.sessionDir);
			if (this.disposed) return;

			this.sessions = sortSessionsByMostRecentlyOpened(
				sessions.filter((session) => session.cwd === this.cwd && session.messageCount > 0),
			).slice(0, MAX_SESSIONS);
			this.error = null;
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.sessions.length - 1));
		} catch (error) {
			if (this.disposed) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.disposed) return;
			this.loading = false;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	get selectedSession(): SessionInfo | undefined {
		return this.sessions[this.selectedIndex];
	}

	moveSelection(delta: number): void {
		if (!this.pickerEnabled) return;
		if (this.sessions.length === 0) return;

		const next = this.selectedIndex + delta;
		this.selectedIndex = Math.max(0, Math.min(this.sessions.length - 1, next));
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const push = (text: string) => lines.push(truncateToWidth(text, width));
		const dim = (text: string) => this.theme.fg("dim", text);
		const muted = (text: string) => this.theme.fg("muted", text);
		const accent = (text: string) => this.theme.fg("accent", text);
		const text = (value: string) => this.theme.fg("text", value);

		push(accent(this.theme.bold("Recent sessions")));
		lines.push("");

		if (this.loading) {
			push(muted("Loading sessions…"));
			push(dim("Enter opens the selected session."));
			return this.cache(width, lines);
		}

		if (this.error) {
			push(this.theme.fg("warning", `Could not load sessions: ${this.error}`));
			return this.cache(width, lines);
		}

		if (this.sessions.length === 0) {
			push(muted("No recent sessions in this folder"));
			push(dim("Typing keeps the prompt as the only active input."));
			return this.cache(width, lines);
		}

		for (const [index, session] of this.sessions.entries()) {
			const isSelected = this.pickerEnabled && index === this.selectedIndex;
			const prefix = isSelected ? accent("> ") : dim("  ");
			const preview = buildSessionPreview(session);
			const row = `${prefix}${isSelected ? accent(preview) : text(preview)}${dim(` · ${formatRelativeTime(session.modified)}`)}`;
			push(row);
		}

		lines.push("");
		if (this.pickerEnabled) {
			push(dim("↑↓ choose · Enter open · Esc close"));
		} else {
			push(dim("Typing keeps the list closed."));
		}

		return this.cache(width, lines);
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.disposed = true;
	}
}

async function loadRecentSessions(ctx: Pick<WelcomeContext, "cwd" | "sessionManager">): Promise<void> {
	recentSessionsLoaded = false;
	try {
		const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
		recentSessions = sortSessionsByMostRecentlyOpened(
				sessions.filter((session) => session.cwd === ctx.cwd && session.messageCount > 0),
			).slice(0, MAX_SESSIONS);
	} catch {
		recentSessions = [];
	} finally {
		recentSessionsLoaded = true;
	}
}

function closeWelcomeWidget(ctx: WelcomeContext): void {
	sessionPickerEnabled = false;
	welcomeWidget?.dispose();
	welcomeWidget = undefined;
	ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
}

function syncWelcomeWidget(ctx: WelcomeContext): void {
	if (!ctx.hasUI) return;

	if (ctx.ui.getEditorText().trim().length > 0) {
		closeWelcomeWidget(ctx);
		return;
	}

	if (recentSessions.length === 0) {
		closeWelcomeWidget(ctx);
		return;
	}

	sessionPickerEnabled = true;

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			welcomeWidget?.dispose();
			welcomeWidget = new RecentSessionsWidget(tui, theme, ctx.cwd, ctx.sessionManager.getSessionDir());
			welcomeWidget.setPickerEnabled(sessionPickerEnabled);
			return welcomeWidget;
		},
		{ placement: "belowEditor" },
	);
}

function installTerminalInputBridge(ctx: WelcomeContext): void {
	if (!ctx.hasUI) return;

	terminalInputUnsubscribe?.();
	terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
		if (recentSessions.length === 0) return;

		const editorHasText = ctx.ui.getEditorText().trim().length > 0;
		if (editorHasText) {
			if (sessionPickerEnabled || welcomeWidget) {
				closeWelcomeWidget(ctx);
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			if (!welcomeWidget) {
				sessionPickerEnabled = true;
				syncWelcomeWidget(ctx);
				welcomeWidget?.setPickerEnabled(true);
				return { consume: true };
			}

			sessionPickerEnabled = true;
			welcomeWidget.setPickerEnabled(true);
			return { consume: true };
		}

		const widget = welcomeWidget;
		if (!widget) return;

		if (!sessionPickerEnabled) {
			if (!matchesKey(data, Key.up) && !matchesKey(data, Key.down) && !matchesKey(data, Key.escape) && !matchesKey(data, Key.enter)) {
				closeWelcomeWidget(ctx);
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			widget.moveSelection(-1);
			return { consume: true };
		}

		if (matchesKey(data, Key.down)) {
			widget.moveSelection(1);
			return { consume: true };
		}

		if (matchesKey(data, Key.escape)) {
			closeWelcomeWidget(ctx);
			ctx.ui.notify("Session picker closed", "info");
			return { consume: true };
		}

		if (matchesKey(data, Key.enter)) {
			if (!recentSessionsLoaded) {
				ctx.ui.notify("Recent sessions are still loading", "warning");
				return { consume: true };
			}

			const selected = widget.selectedSession;
			if (!selected) return { consume: true };

			const index = recentSessions.findIndex((session) => session.path === selected.path);
			if (index === -1) return { consume: true };

			ctx.ui.setEditorText(`/recent ${index + 1}`);
			return { data };
		}

		closeWelcomeWidget(ctx);
	});
}

function resetWelcomeState(ctx: WelcomeContext): void {
	terminalInputUnsubscribe?.();
	terminalInputUnsubscribe = undefined;
	closeWelcomeWidget(ctx);
}

export default function welcomeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("recent", {
		description: "Open a recent session by number (1-5)",
		handler: async (args, ctx) => {
			const value = args.trim();
			const index = Number.parseInt(value, 10);

			if (!recentSessionsLoaded) {
				ctx.ui.notify("Recent sessions are still loading", "warning");
				return;
			}

			if (!Number.isInteger(index) || index < 1) {
				ctx.ui.notify(`Usage: /recent <1-${Math.max(1, recentSessions.length)}>`, "warning");
				return;
			}

			const session = recentSessions[index - 1];
			if (!session) {
				ctx.ui.notify(`No recent session at position ${index}`, "warning");
				return;
			}

			const result = await ctx.switchSession(session.path);
			if (result.cancelled) {
				return;
			}

			ctx.ui.setEditorText("");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		markSessionOpened((ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.());
		await loadRecentSessions(ctx);
		syncWelcomeWidget(ctx);
		installTerminalInputBridge(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		markSessionOpened((ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.());
		await loadRecentSessions(ctx);
		closeWelcomeWidget(ctx);
		installTerminalInputBridge(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		resetWelcomeState(ctx);
	});
}
