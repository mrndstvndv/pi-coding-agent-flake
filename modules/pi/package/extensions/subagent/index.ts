import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	closeHerdrTab,
	effectiveRunState,
	focusHerdrAgent,
	hasHerdrTab,
	inboxDir,
	launchRun,
	listHerdrAgents,
	listHerdrTabs,
	listRuns,
	type HerdrAgent,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	requireHerdrContext,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata, agents: HerdrAgent[]): string {
	return effectiveRunState(metadata, agents).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and focus a subagent spawned by this session",
		handler: async (_args, ctx) => {
			try {
				requireHerdrContext();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			let agents;
			try {
				agents = await listHerdrAgents();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter(
				(run) => effectiveRunState(run, agents) !== "exited",
			);
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run, agents)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Focus on subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "focus")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run?.herdrPaneId) return;
			try {
				await focusHerdrAgent(run.herdrPaneId);
			} catch (error) {
				ctx.ui.notify(`Could not focus ${run.handle}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		let refreshingWidget = false;
		let lastWidgetError: string | undefined;

		const refreshWidget = async (): Promise<void> => {
			const context = widgetContext;
			if (!context || refreshingWidget) return;
			refreshingWidget = true;
			try {
				const agents = await listHerdrAgents();
				if (widgetContext !== context) return;
				const activeRuns = listRuns(context.sessionManager.getSessionId())
					.map((run) => ({ run, state: effectiveRunState(run, agents) }))
					.filter(({ state }) => state !== "exited");
				if (activeRuns.length === 0) {
					context.ui.setWidget("subagents", undefined);
					lastWidgetError = undefined;
					return;
				}

				const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
					const color =
						state === "busy" || state === "blocked"
							? "warning"
							: state === "idle"
								? "success"
								: state === "error"
									? "error"
									: "muted";
					return context.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
				});
				if (activeRuns.length > visible.length) {
					visible.push(context.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
				}
				context.ui.setWidget(
					"subagents",
					[context.ui.theme.fg("dim", "subagents: ") + visible.join(context.ui.theme.fg("dim", " | "))],
					{ placement: "belowEditor" },
				);
				lastWidgetError = undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (widgetContext === context && lastWidgetError !== message) {
					context.ui.notify(`Could not refresh subagents: ${message}`, "warning");
				}
				lastWidgetError = message;
			} finally {
				refreshingWidget = false;
			}
		};

		pi.on("session_start", async (_event, ctx) => {
			try {
				requireHerdrContext();
			} catch {
				return;
			}

			// Relaunch children that were suspended when this session was last quit or switched away from.
			let agents: HerdrAgent[];
			try {
				agents = await listHerdrAgents();
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not query Herdr agents: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended) continue;
				try {
					const tabExists = await hasHerdrTab(run);
					const agentExists = agents.some((agent) => agent.pane_id === run.herdrPaneId);
					if (tabExists && agentExists) {
						updateMetadata(run.runDir, { suspended: undefined });
						continue;
					}
					if (tabExists && run.herdrTabId) await closeHerdrTab(run.herdrTabId);
					if (!existsSync(run.sessionFile)) {
						removeRunDir(run.runDir);
						continue;
					}
					const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
					const resumed = await launchRun(starting);
					agents = await listHerdrAgents();
					if (ctx.hasUI) ctx.ui.notify(`Resumed subagent ${runDisplayName(resumed)}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			void refreshWidget();
			widgetTimer = setInterval(() => void refreshWidget(), 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			try {
				requireHerdrContext();
			} catch {
				return;
			}

			let agents: HerdrAgent[];
			try {
				agents = await listHerdrAgents();
			} catch {
				return;
			}
			const tabsByWorkspace = new Map<string, string[]>();
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				try {
					let tabs = tabsByWorkspace.get(run.herdrWorkspaceId);
					if (!tabs) {
						tabs = await listHerdrTabs(run.herdrWorkspaceId);
						tabsByWorkspace.set(run.herdrWorkspaceId, tabs);
					}
					const tabExists = !!run.herdrTabId && tabs.includes(run.herdrTabId);
					const agentExists = agents.some((agent) => agent.pane_id === run.herdrPaneId);
					if (!tabExists) {
						if (!run.suspended) removeRunDir(run.runDir);
						continue;
					}
					if (!agentExists || run.state === "exited") {
						await closeHerdrTab(run.herdrTabId!);
						removeRunDir(run.runDir);
						continue;
					}
					updateMetadata(run.runDir, { suspended: true });
					await closeHerdrTab(run.herdrTabId!);
					await waitForRunShutdown(run.runDir);
				} catch (error) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Could not suspend subagent ${runDisplayName(run)}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				}
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
