import { readFile, access, constants } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Key,
	type SelectItem,
	SelectList,
	Text,
	Input,
	fuzzyFilter,
	matchesKey,
	Spacer,
} from "@mariozechner/pi-tui";

// Image MIME types we support
const SUPPORTED_IMAGE_MIME_TYPES = new Map<string, string>([
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["png", "image/png"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);

const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB for text files
const DEFAULT_MAX_LINES = 2000;

interface FileItem {
	path: string;
	isImage: boolean;
}

function detectImageMimeType(filePath: string): string | null {
	const ext = path.extname(filePath).toLowerCase().replace(".", "");
	return SUPPORTED_IMAGE_MIME_TYPES.get(ext) || null;
}

function truncateContent(content: string): { text: string; wasTruncated: boolean } {
	const lines = content.split("\n");
	const bytes = Buffer.byteLength(content, "utf-8");

	let truncated = content;
	let wasTruncated = false;

	if (lines.length > DEFAULT_MAX_LINES || bytes > DEFAULT_MAX_BYTES) {
		wasTruncated = true;
		// Keep first N lines that fit within byte limit
		let result: string[] = [];
		let currentBytes = 0;

		for (let i = 0; i < Math.min(lines.length, DEFAULT_MAX_LINES); i++) {
			const line = lines[i];
			const lineBytes = Buffer.byteLength(line, "utf-8");
			if (currentBytes + lineBytes > DEFAULT_MAX_BYTES) break;
			result.push(line);
			currentBytes += lineBytes + 1; // +1 for newline
		}

		truncated = result.join("\n");
	}

	return { text: truncated, wasTruncated };
}

async function readFileContent(
	filePath: string,
	cwd: string,
): Promise<{ type: "text"; content: string; wasTruncated: boolean } | { type: "image"; data: string; mimeType: string } | null> {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

	try {
		await access(absolutePath, constants.R_OK);

		const mimeType = detectImageMimeType(filePath);
		if (mimeType) {
			const buffer = await readFile(absolutePath);
			return {
				type: "image",
				data: buffer.toString("base64"),
				mimeType,
			};
		}

		const buffer = await readFile(absolutePath);
		const textContent = buffer.toString("utf-8");
		const { text, wasTruncated } = truncateContent(textContent);
		return { type: "text", content: text, wasTruncated };
	} catch {
		return null;
	}
}

async function getFilesForFuzzySearch(cwd: string): Promise<FileItem[]> {
	const items: FileItem[] = [];

	try {
		const { execSync } = await import("node:child_process");
		let output: string;

		// Try fd first, then fallback to find
		try {
			output = execSync(
				"fd --type f --hidden --exclude node_modules --exclude .git .",
				{
					cwd,
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
				},
			);
		} catch {
			output = execSync(
				"find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1000",
				{
					cwd,
					encoding: "utf-8",
				},
			);
		}

		const lines = output.split("\n").filter((line) => line.trim() && !line.startsWith("./."));

		for (const line of lines) {
			const cleanPath = line.replace(/^\.\//, "").trim();
			if (!cleanPath) continue;

			// Skip directories - verify it's actually a file
			try {
				const fullPath = path.join(cwd, cleanPath);
				const stats = statSync(fullPath);
				if (!stats.isFile()) continue;
			} catch {
				continue; // Skip if we can't stat it
			}

			const ext = path.extname(cleanPath).toLowerCase();
			const isImage = SUPPORTED_IMAGE_MIME_TYPES.has(ext.replace(".", ""));

			items.push({ path: cleanPath, isImage });
		}
	} catch {
		// Fallback: return empty list, user can input path manually
	}

	return items;
}

type StagedTextFile = {
	kind: "text";
	path: string;
	content: string;
	wasTruncated: boolean;
};

type StagedImageFile = {
	kind: "image";
	path: string;
	image: ImageContent;
};

type StagedFile = StagedTextFile | StagedImageFile;

export default function fileCommandExtension(pi: ExtensionAPI) {
	const stagedFiles: StagedFile[] = [];

	function updateStagingUi(ctx: ExtensionContext) {
		if (stagedFiles.length === 0) {
			ctx.ui.setWidget("file-staging", undefined);
			ctx.ui.setStatus("file-staging", undefined);
			return;
		}

		const lines = [ctx.ui.theme.fg("accent", `Staged files (${stagedFiles.length})`), ""];
		for (const staged of stagedFiles) {
			const prefix = staged.kind === "image" ? "🖼" : "📄";
			lines.push(`${prefix} ${staged.path}`);
		}
		lines.push("");
		lines.push(ctx.ui.theme.fg("dim", "Run /file again to add more. Submit your prompt to send all staged files."));

		ctx.ui.setWidget("file-staging", lines);
		ctx.ui.setStatus("file-staging", ctx.ui.theme.fg("accent", `files:${stagedFiles.length}`));
	}

	function buildFileBlocks(): string {
		const blocks: string[] = [];
		for (const staged of stagedFiles) {
			if (staged.kind === "image") {
				blocks.push(`<file path="${staged.path}">\n[image attached]\n</file>`);
				continue;
			}

			let text = `<file path="${staged.path}">\n${staged.content}`;
			if (staged.wasTruncated) {
				text += "\n[File truncated - use read tool for full content]";
			}
			text += "\n</file>";
			blocks.push(text);
		}
		return blocks.join("\n\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		stagedFiles.length = 0;
		updateStagingUi(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (stagedFiles.length === 0) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().startsWith("/")) return { action: "continue" };

		const fileBlocks = buildFileBlocks();
		const text = event.text.trim().length > 0 ? `${event.text}\n\n${fileBlocks}` : fileBlocks;

		const stagedImages = stagedFiles
			.filter((file): file is StagedImageFile => file.kind === "image")
			.map((file) => file.image);
		const mergedImages = [...(event.images ?? []), ...stagedImages];

		stagedFiles.length = 0;
		updateStagingUi(ctx);

		return {
			action: "transform",
			text,
			images: mergedImages.length > 0 ? mergedImages : undefined,
		};
	});

	pi.registerCommand("file", {
		description: "Stage a file for the next prompt submission",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/file command requires interactive TUI mode", "error");
				return;
			}

			const files = await getFilesForFuzzySearch(ctx.cwd);

			const result = await ctx.ui.custom<
				| { type: "selected"; path: string }
				| { type: "manual"; path: string }
				| null
			>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select File")), 1, 0));
				container.addChild(new Text(theme.fg("muted", `${ctx.cwd}`), 1, 0));
				container.addChild(new Spacer(1));

				let mode: "search" | "manual" = "search";
				let filteredFiles = files;
				const searchInput = new Input();
				const manualInput = new Input();
				let selectList: SelectList | null = null;

				const buildSelectItems = (): SelectItem[] => {
					if (filteredFiles.length === 0) {
						return [{ value: "__no_results__", label: "No files match", description: "Press Tab for manual path" }];
					}
					return filteredFiles.map((f) => ({
						value: f.path,
						label: f.isImage ? `${f.path} [image]` : f.path,
						description: f.isImage ? "Image file" : "Text file",
					}));
				};

				const updateSelectList = () => {
					const items = buildSelectItems();
					selectList = new SelectList(items, Math.min(15, Math.max(5, items.length)), {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});
					selectList.onSelect = (item) => {
						if (item.value !== "__no_results__") done({ type: "selected", path: item.value });
					};
				};

				searchInput.onChange = (value: string) => {
					filteredFiles = value.trim() ? fuzzyFilter(files, value, (f) => f.path) : files;
					updateSelectList();
					tui.requestRender();
				};

				manualInput.onSubmit = (value: string) => {
					if (value.trim()) done({ type: "manual", path: value.trim() });
				};

				updateSelectList();
				const contentContainer = new Container();
				const refreshContent = () => {
					contentContainer.clear();
					if (mode === "search") {
						contentContainer.addChild(new Text(theme.fg("dim", "Search files (type to filter):"), 1, 0));
						contentContainer.addChild(searchInput);
						contentContainer.addChild(new Spacer(1));
						if (selectList) contentContainer.addChild(selectList);
						return;
					}
					contentContainer.addChild(new Text(theme.fg("dim", "Enter file path (absolute or relative):"), 1, 0));
					contentContainer.addChild(manualInput);
				};

				refreshContent();
				container.addChild(contentContainer);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate • enter select • tab manual input • esc cancel"),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						}
						if (matchesKey(data, Key.tab)) {
							mode = mode === "search" ? "manual" : "search";
							refreshContent();
							tui.requestRender();
							return;
						}
						if (mode === "search") {
							if (selectList) selectList.handleInput(data);
							searchInput.handleInput(data);
						} else {
							manualInput.handleInput(data);
						}
						tui.requestRender();
					},
				};
			});

			if (!result) {
				ctx.ui.notify("File selection cancelled", "info");
				return;
			}

			const absolutePath = path.isAbsolute(result.path) ? result.path : path.join(ctx.cwd, result.path);
			const relativePath = path.relative(ctx.cwd, absolutePath);
			const displayPath = relativePath.startsWith("..") ? absolutePath : relativePath;

			ctx.ui.notify(`Reading ${displayPath}...`, "info");
			const fileContent = await readFileContent(result.path, ctx.cwd);
			if (!fileContent) {
				ctx.ui.notify(`Failed to read file: ${result.path}`, "error");
				return;
			}

			if (fileContent.type === "image") {
				const image: ImageContent = {
					type: "image",
					source: {
						type: "base64",
						mediaType: fileContent.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
						data: fileContent.data,
					},
				};
				stagedFiles.push({ kind: "image", path: displayPath, image });
			} else {
				stagedFiles.push({
					kind: "text",
					path: displayPath,
					content: fileContent.content,
					wasTruncated: fileContent.wasTruncated,
				});
			}

			updateStagingUi(ctx);
			ctx.ui.notify(`Staged ${displayPath} (${stagedFiles.length} total)`, "info");
		},
	});
}
