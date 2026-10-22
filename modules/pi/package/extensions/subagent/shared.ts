import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "blocked" | "exited" | "error";

export interface RunMetadata {
	version: 2;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	herdrWorkspaceId: string;
	herdrTabId?: string;
	herdrPaneId?: string;
	herdrAgentName: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface HerdrAgent {
	pane_id: string;
	agent_status: string;
	name?: string;
}

export interface HerdrContext {
	workspaceId: string;
	tabId: string;
	paneId: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function requireHerdrContext(): HerdrContext {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const tabId = process.env.HERDR_TAB_ID;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !workspaceId || !tabId || !paneId) {
		throw new Error("Pi subagents require the parent Pi process to run inside a Herdr-managed pane (HERDR_ENV=1).");
	}
	return { workspaceId, tabId, paneId };
}

export function runHerdr(args: string[], timeoutMs = 10_000): Promise<string> {
	return new Promise((resolveOutput, rejectOutput) => {
		const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`herdr ${args.join(" ")} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref();

		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) rejectOutput(error);
			else resolveOutput(stdout.trim());
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) => finish(new Error(`Could not run herdr: ${error.message}`)));
		child.on("close", (status, signal) => {
			if (status === 0) {
				finish();
				return;
			}
			finish(new Error(stderr.trim() || stdout.trim() || `herdr ${args.join(" ")} failed (${signal ?? status})`));
		});
	});
}

function herdrResult<T>(output: string): T {
	let response: unknown;
	try {
		response = JSON.parse(output);
	} catch {
		throw new Error(`Invalid JSON returned by Herdr: ${output || "(empty response)"}`);
	}
	if (typeof response !== "object" || response === null || !("result" in response)) {
		throw new Error("Herdr response did not contain a result");
	}
	return (response as { result: T }).result;
}

export async function listHerdrAgents(): Promise<HerdrAgent[]> {
	const result = herdrResult<{ agents?: unknown }>(await runHerdr(["agent", "list"]));
	if (!Array.isArray(result.agents)) throw new Error("Herdr agent list response did not contain agents");
	return result.agents.filter((agent): agent is HerdrAgent => {
		if (typeof agent !== "object" || agent === null) return false;
		const candidate = agent as Record<string, unknown>;
		return typeof candidate.pane_id === "string" && typeof candidate.agent_status === "string";
	});
}

export async function listHerdrTabs(workspaceId: string): Promise<string[]> {
	const result = herdrResult<{ tabs?: unknown }>(await runHerdr(["tab", "list", "--workspace", workspaceId]));
	if (!Array.isArray(result.tabs)) throw new Error("Herdr tab list response did not contain tabs");
	return result.tabs.flatMap((tab) => {
		if (typeof tab !== "object" || tab === null) return [];
		const tabId = (tab as Record<string, unknown>).tab_id;
		return typeof tabId === "string" ? [tabId] : [];
	});
}

export async function hasHerdrTab(metadata: RunMetadata): Promise<boolean> {
	if (!metadata.herdrTabId) return false;
	return (await listHerdrTabs(metadata.herdrWorkspaceId)).includes(metadata.herdrTabId);
}

export async function closeHerdrTab(tabId: string): Promise<void> {
	await runHerdr(["tab", "close", tabId]);
}

export async function focusHerdrAgent(paneId: string): Promise<void> {
	await runHerdr(["agent", "focus", paneId]);
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 2 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.herdrWorkspaceId !== "string" ||
			(metadata.herdrTabId !== undefined && typeof metadata.herdrTabId !== "string") ||
			(metadata.herdrPaneId !== undefined && typeof metadata.herdrPaneId !== "string") ||
			typeof metadata.herdrAgentName !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 2,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Start a Pi agent in its own Herdr tab. `initialArgs` are only used on first spawn. */
export async function launchRun(metadata: RunMetadata, initialArgs: string[] = []): Promise<RunMetadata> {
	const { workspaceId } = requireHerdrContext();
	const label = `Subagent ${metadata.name ?? metadata.handle}`;
	const created = herdrResult<{
		tab?: { tab_id?: unknown };
		root_pane?: { pane_id?: unknown };
	}>(
		await runHerdr([
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			metadata.cwd,
			"--label",
			label,
			"--env",
			`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
			"--no-focus",
		]),
	);
	const tabId = created.tab?.tab_id;
	const paneId = created.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") {
		throw new Error("Herdr did not return the new subagent tab and pane IDs");
	}

	const started: RunMetadata = {
		...metadata,
		herdrWorkspaceId: workspaceId,
		herdrTabId: tabId,
		herdrPaneId: paneId,
		state: "starting",
		suspended: undefined,
	};
	writeMetadata(started);

	try {
		await runHerdr(
			[
				"agent",
				"start",
				started.herdrAgentName,
				"--kind",
				"pi",
				"--pane",
				paneId,
				"--timeout",
				"120000",
				"--",
				"--session",
				started.sessionFile,
				"--provider",
				started.provider,
				"--model",
				started.model,
				"--thinking",
				started.thinking,
				...(started.launchArgs ?? []),
				...initialArgs,
			],
			125_000,
		);
		return started;
	} catch (error) {
		try {
			await closeHerdrTab(tabId);
		} catch {
			// Preserve the launch error; Herdr may already have closed the failed tab.
		}
		updateMetadata(started.runDir, {
			state: "error",
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function effectiveRunState(metadata: RunMetadata, agents: HerdrAgent[]): RunState {
	if (metadata.state === "error" || metadata.state === "exited") return metadata.state;
	if (!metadata.herdrPaneId) return metadata.state === "starting" ? "starting" : "exited";
	const agent = agents.find((candidate) => candidate.pane_id === metadata.herdrPaneId);
	if (!agent) return metadata.state === "starting" ? "starting" : "exited";
	switch (agent.agent_status) {
		case "working":
			return "busy";
		case "idle":
		case "done":
			return "idle";
		case "blocked":
			return "blocked";
		default:
			return metadata.state;
	}
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
