/**
 * Ask Tool - Ask the user one or more questions and collect responses.
 * Each question supports optional structured options plus a free-form answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import { execSync } from "child_process";

const MAX_MESSAGE_LENGTH = 80;
const NOTIFY_TITLE = "Pi needs your input";
const CUSTOM_OPTION_LABEL = "Type something.";

function sanitizeOscValue(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/[;\\]/g, " ").trim();
}

function shortenMessage(value: string): string {
	if (value.length <= MAX_MESSAGE_LENGTH) return value;
	return `${value.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}

function writeToTty(ttyPath: string, data: string): boolean {
	try {
		fs.appendFileSync(ttyPath, data);
		return true;
	} catch {
		return false;
	}
}

function buildOsc(payload: string): string {
	return `\x1b]${payload}\x07`;
}

function buildTmuxPassthrough(payload: string): string {
	return `\x1bPtmux;\x1b\x1b]${payload}\x07\x1b\\`;
}

function sendOsc777(ttyPath: string, title: string, message: string): boolean {
	return writeToTty(ttyPath, buildOsc(`777;notify;${title};${message}`));
}

function getTmuxClientTtys(): string[] {
	try {
		const output = execSync("tmux list-clients -F '#{client_tty}'", {
			encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		});

		const uniqueTtys = new Set<string>();
		for (const line of output.split("\n")) {
			const tty = line.trim();
			if (!tty) continue;
			uniqueTtys.add(tty);
		}

		return [...uniqueTtys];
	} catch {
		return [];
	}
}

function notify(message: string, duration = "5000"): void {
	const inTmux = Boolean(process.env.TMUX);
	const hasTty = Boolean(process.stdout.isTTY);
	if (!inTmux && !hasTty) return;

	const safeMessage = sanitizeOscValue(shortenMessage(message));
	const safeTitle = sanitizeOscValue(NOTIFY_TITLE);

	if (!inTmux) {
		const sent = sendOsc777("/dev/tty", safeTitle, safeMessage);
		if (!sent) process.stdout.write(buildOsc(`777;notify;${safeTitle};${safeMessage}`));
		return;
	}

	try {
		execSync(`tmux display-message -d ${duration} 'Pi: ${safeMessage}'`);
	} catch {
		// Ignore tmux status errors; notification writes still attempted below.
	}

	const clientTtys = getTmuxClientTtys();
	let sent = false;

	for (const tty of clientTtys) {
		sent = sendOsc777(tty, safeTitle, safeMessage) || sent;
	}

	if (sent) return;

	process.stdout.write(buildTmuxPassthrough(`777;notify;${safeTitle};${safeMessage}`));
}

interface AskAnswer {
	question: string;
	answer: string;
	wasCustom: boolean;
}

interface AskDetails {
	answers: AskAnswer[];
}

interface DisplayOption {
	label: string;
	detail?: string;
	isOther?: boolean;
}

const OptionParams = Type.Object({
	label: Type.String({ description: "Short label for the choice" }),
	detail: Type.Optional(Type.String({ description: "Optional one-line explanation of the choice" })),
});

const QuestionParams = Type.Object({
	question: Type.String({
		description:
			"The question, as one concise line. Shown as the transcript header. Do not put options or multi-paragraph background here.",
	}),
	details: Type.Optional(
		Type.String({
			description:
				"Supporting context or prose background. Shown only in the interactive prompt, never in the transcript.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionParams, {
			description:
				'Optional choices. A free-form "Type something." option is always appended, so users can still answer freely.',
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionParams, {
		minItems: 1,
		description:
			"One or more questions to ask in sequence. Use a single entry for a simple question; batch related questions into one call.",
	}),
});

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user one or more questions and collect their responses. Each question supports choices and/or a free-form answer.",
		promptSnippet: "Ask the user one or more questions and collect their responses",
		promptGuidelines: [
			"Use the ask tool when you need user input.",
			"Keep each question to one concise line; put background in details and discrete choices in options.",
			"Batch related questions into a single call; they are asked in sequence.",
			"Prefer options when the answer is a choice, and omit them for open-ended input.",
		],
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions;

			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { answers: [] } as AskDetails,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { answers: [] } as AskDetails,
				};
			}

			const notifyText = questions.length === 1 ? questions[0].question : `${questions.length} questions`;
			notify(`${NOTIFY_TITLE}: ${notifyText}`);

			// The herdr agent-state integration only knows about pi's built-in prompts
			// through the `herdr:blocked` bus event, so report the wait ourselves.
			pi.events.emit("herdr:blocked", { active: true, label: notifyText });

			const result = await ctx.ui.custom<{ answers: AskAnswer[] } | null>((tui, theme, _kb, done) => {
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				const answers: Array<{ answer: string; wasCustom: boolean } | null> = new Array(questions.length).fill(
					null,
				);
				let questionIndex = 0;
				let optionIndex = 0;
				// No options means the question is open-ended: go straight to the editor.
				let editMode = currentOptions().length === 0;

				function currentQuestion() {
					return questions[questionIndex];
				}

				function currentOptions() {
					return currentQuestion().options ?? [];
				}

				function refresh() {
					tui.requestRender();
				}

				function finish() {
					done({
						answers: questions.map((question, i) => ({
							question: question.question,
							answer: answers[i]?.answer ?? "",
							wasCustom: answers[i]?.wasCustom ?? true,
						})),
					});
				}

				function submitAnswer(answer: string, wasCustom: boolean) {
					answers[questionIndex] = { answer, wasCustom };
					if (questionIndex + 1 >= questions.length) {
						finish();
						return;
					}
					questionIndex++;
					optionIndex = 0;
					editMode = currentOptions().length === 0;
					editor.setText(answers[questionIndex]?.answer ?? "");
					refresh();
				}

				/** Escape: step back a question when possible, otherwise cancel the whole prompt. */
				function goBackOrCancel() {
					if (questionIndex === 0) {
						done(null);
						return;
					}
					questionIndex--;
					optionIndex = 0;
					const options = currentOptions();
					const previous = answers[questionIndex];
					if (!previous || previous.wasCustom || options.length === 0) {
						editMode = true;
						editor.setText(previous?.answer ?? "");
					} else {
						editMode = false;
						const match = options.findIndex((option) => option.label === previous.answer);
						optionIndex = match >= 0 ? match : 0;
						editor.setText("");
					}
					refresh();
				}

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						submitAnswer(trimmed, true);
						return;
					}
					if (currentOptions().length > 0) {
						editMode = false;
						editor.setText("");
						refresh();
					}
				};

				function handleInput(data: string) {
					const options = currentOptions();
					const allOptions: DisplayOption[] = [...options, { label: CUSTOM_OPTION_LABEL, isOther: true }];

					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							if (options.length === 0) {
								goBackOrCancel();
								return;
							}
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const selected = allOptions[optionIndex];
						if (selected.isOther) {
							editMode = true;
							refresh();
						} else {
							submitAnswer(selected.label, false);
						}
						return;
					}
					if (matchesKey(data, Key.escape)) {
						goBackOrCancel();
					}
				}

				function render(width: number): string[] {
					const question = currentQuestion();
					const options = currentOptions();
					const allOptions: DisplayOption[] = [...options, { label: CUSTOM_OPTION_LABEL, isOther: true }];
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const add = (s: string) => lines.push(truncateToWidth(s, renderWidth));
					const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, renderWidth));
					const addPrefixed = (prefix: string, s: string) => {
						const prefixWidth = visibleWidth(prefix);
						const wrapped = wrapTextWithAnsi(s, Math.max(1, renderWidth - prefixWidth));
						const continuation = " ".repeat(prefixWidth);
						wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : continuation}${line}`));
					};

					add(theme.fg("accent", "─".repeat(renderWidth)));
					if (questions.length > 1) {
						add(theme.fg("dim", ` Question ${questionIndex + 1}/${questions.length}`));
					}
					// Wrap (not truncate) so multi-line text stays fully visible.
					addPrefixed(" ", theme.fg("text", question.question));
					if (question.details) {
						lines.push("");
						addPrefixed(" ", theme.fg("muted", question.details));
					}

					if (options.length > 0) {
						lines.push("");
						for (let i = 0; i < allOptions.length; i++) {
							const option = allOptions[i];
							const selected = i === optionIndex;
							const isOther = option.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = isOther && editMode ? `${CUSTOM_OPTION_LABEL} ✎` : option.label;
							addPrefixed(prefix, theme.fg(selected ? "accent" : "text", label));
							if (option.detail) {
								addPrefixed("    ", theme.fg("muted", option.detail));
							}
						}
					}

					if (editMode) {
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(renderWidth - 2)) {
							add(` ${line}`);
						}
					}

					lines.push("");
					const canGoBack = questionIndex > 0;
					const back = canGoBack ? "Esc to go back" : "Esc to cancel";
					if (options.length === 0) {
						add(theme.fg("dim", ` Enter to submit • ${back}`));
					} else if (editMode) {
						add(theme.fg("dim", ` Enter to submit • Esc ${canGoBack ? "back to options" : "to cancel"}`));
					} else {
						add(theme.fg("dim", ` ↑↓ navigate • Enter to select • ${back}`));
					}
					add(theme.fg("accent", "─".repeat(renderWidth)));

					return lines;
				}

				return { render, handleInput, invalidate: () => {} };
			}).finally(() => {
				// Clear the blocked state even when the prompt is cancelled or throws.
				pi.events.emit("herdr:blocked", { active: false });
			});

			notify("Input received — resuming task", "3000");

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the prompt" }],
					details: { answers: [] } as AskDetails,
				};
			}

			const summary = result.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
			return {
				content: [{ type: "text", text: summary }],
				details: { answers: result.answers } as AskDetails,
			};
		},

		renderCall(args, theme, _context) {
			// Only the one-line questions reach the transcript; details and options are UI-only.
			const questions = args.questions ?? [];
			const header = theme.fg("toolTitle", theme.bold("ask "));
			const body = questions.map((question) => theme.fg("muted", question.question)).join("\n    ");
			return new Text(header + body, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			if (!details || details.answers.length === 0) {
				const text = result.content[0];
				return new Text(theme.fg("warning", text?.type === "text" ? text.text : "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer, i) => {
				const index = details.answers.length > 1 ? theme.fg("dim", `${i + 1}. `) : "";
				const wrote = answer.wasCustom ? theme.fg("muted", "(wrote) ") : "";
				return index + theme.fg("success", "✓ ") + wrote + theme.fg("accent", answer.answer);
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
