// Replaces the built-in `@...` file-attachment autocomplete with FFF
// (@ff-labs/fff-node): a persistent, git-aware, typo-resistant index instead of
// a fresh `fd` walk on every keystroke.
//
// Scope is intentionally narrow: only the `@` attachment token is intercepted.
// Everything else (slash commands, `~/`, `./`, `/`, trailing-slash directory
// listing, command arguments) is delegated to the built-in provider.
//
// If FFF or its native binary is unavailable, the wrapper degrades back to the
// built-in provider so attachments keep working.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { FileFinder, type FileFinderApi, type MixedItem } from "@ff-labs/fff-node";

const MAX_SUGGESTIONS = 30;
const SCAN_TIMEOUT_MS = 15_000;

// Token boundaries copied from pi-tui's CombinedAutocompleteProvider so the
// wrapper intercepts exactly the `@` tokens the built-in provider would have.
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const CJK_BREAK =
	"[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Bopomofo}]";
const CJK_PUNCTUATION = `(?:(?=\\p{Punctuation})${CJK_BREAK}|[，．：；！？（）［］｛｝“”‘’…—])`;
const SEPARATOR_REGEX = new RegExp(`(?:\\s|${CJK_PUNCTUATION})`, "u");
const TOKEN_START_REGEX = new RegExp(`(?:^|${SEPARATOR_REGEX.source})$`, "u");

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}
	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return PATH_DELIMITERS.has(text[index - 1] ?? "") || TOKEN_START_REGEX.test(text.slice(0, index));
}

function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || SEPARATOR_REGEX.test(character)) {
			lastDelimiter = index - 1;
		}
	}
	return lastDelimiter;
}

/** Returns the quoted token ending at the cursor, or null when absent. */
function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}
	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		return isTokenStart(text, quoteStart - 1) ? text.slice(quoteStart - 1) : null;
	}
	return isTokenStart(text, quoteStart) ? text.slice(quoteStart) : null;
}

/** Returns the raw `@...` token ending at the cursor, or null when absent. */
function extractAtPrefix(text: string): string | null {
	const quotedPrefix = extractQuotedPrefix(text);
	if (quotedPrefix?.startsWith('@"')) {
		return quotedPrefix;
	}

	const lastDelimiterIndex = findLastDelimiter(text);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	return text[tokenStart] === "@" ? text.slice(tokenStart) : null;
}

type AtQuery = { query: string; quoted: boolean };

function parseAtPrefix(prefix: string): AtQuery {
	if (prefix.startsWith('@"')) {
		return { query: prefix.slice(2), quoted: true };
	}
	return { query: prefix.slice(1), quoted: false };
}

// Queries the built-in provider resolves itself (`~/`, absolute, explicit
// relative dirs) are left untouched.
function isBuiltinScopedQuery(query: string): boolean {
	return (
		query === "~" ||
		query.startsWith("~/") ||
		query.startsWith("/") ||
		query.startsWith("./") ||
		query.startsWith("../")
	);
}

function joinBase(basePath: string, path: string): string {
	return isAbsolute(path) ? path : join(basePath, path);
}

function completionValue(path: string, quoted: boolean): string {
	const needsQuotes = quoted || SEPARATOR_REGEX.test(path);
	return needsQuotes ? `@"${path}"` : `@${path}`;
}

function toAutocompleteItem(entry: MixedItem, quoted: boolean): AutocompleteItem {
	if (entry.type === "directory") {
		const relativePath = entry.item.relativePath.replace(/\/+$/, "");
		return {
			value: completionValue(`${relativePath}/`, quoted),
			label: `${entry.item.dirName.replace(/\/+$/, "")}/`,
			description: relativePath,
		};
	}
	const relativePath = entry.item.relativePath;
	return {
		value: completionValue(relativePath, quoted),
		label: entry.item.fileName,
		description: relativePath,
	};
}

type FinderManager = {
	readonly finder: FileFinderApi | null;
	readonly basePath: string;
	ensure(): FileFinderApi | null;
	destroy(): void;
};

function createFinderManager(cwd: string, onError: (message: string) => void): FinderManager {
	let finder: FileFinderApi | null = null;
	let failed = false;

	const ensure = (): FileFinderApi | null => {
		if (failed) {
			return null;
		}
		if (finder) {
			return finder;
		}

		try {
			if (!FileFinder.isAvailable()) {
				failed = true;
				onError("fff-attach: native fff library unavailable; using built-in attachment completion");
				return null;
			}

			const dbDir = join(getAgentDir(), "cache", "fff");
			mkdirSync(dbDir, { recursive: true });
			const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
			const created = FileFinder.create({
				basePath: cwd,
				aiMode: true,
				// Only file/dir lookup is needed, so skip the content index and
				// mmap warmup that would otherwise dominate startup memory.
				disableContentIndexing: true,
				disableMmapCache: true,
				frecencyDbPath: join(dbDir, `${key}.frecency`),
				historyDbPath: join(dbDir, `${key}.history`),
			});
			if (!created.ok) {
				failed = true;
				onError(`fff-attach: ${created.error}`);
				return null;
			}

			finder = created.value;
			// Warm the index in the background; searches use whatever is scanned.
			void finder.waitForScan(SCAN_TIMEOUT_MS);
			return finder;
		} catch (error) {
			failed = true;
			onError(`fff-attach: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	};

	return {
		get finder() {
			return finder;
		},
		get basePath() {
			return cwd;
		},
		ensure,
		destroy() {
			finder?.destroy();
			finder = null;
		},
	};
}

function trackSelection(manager: FinderManager, item: AutocompleteItem, prefix: string): void {
	const finder = manager.finder;
	// Directories are an intermediate step; only complete files are real picks.
	if (!finder || item.label.endsWith("/")) {
		return;
	}

	const query = prefix.replace(/^@/, "").replace(/^"|"$/g, "");
	const relativePath = item.value.replace(/^@/, "").replace(/^"|"$/g, "").replace(/\/$/, "");
	if (!query || !relativePath) {
		return;
	}

	try {
		finder.trackQuery(query, joinBase(manager.basePath, relativePath));
	} catch {
		// Frecency is best-effort; never break completion over it.
	}
}

function createAttachProvider(current: AutocompleteProvider, manager: FinderManager): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const prefix = extractAtPrefix(line.slice(0, cursorCol));
			if (prefix === null) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const { query, quoted } = parseAtPrefix(prefix);
			if (isBuiltinScopedQuery(query)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const finder = manager.ensure();
			if (!finder || options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const result = finder.mixedSearch(query, { pageSize: MAX_SUGGESTIONS });
			if (!result.ok || options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = result.value.items.map((entry) => toAutocompleteItem(entry, quoted));
			return items.length === 0 ? null : { items, prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("@")) {
				trackSelection(manager, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	let manager: FinderManager | null = null;

	pi.on("session_start", (_event, ctx) => {
		manager?.destroy();
		manager = createFinderManager(ctx.cwd, (message) => ctx.ui.notify(message, "error"));
		manager.ensure();

		const activeManager = manager;
		ctx.ui.addAutocompleteProvider((current) => createAttachProvider(current, activeManager));
	});

	pi.on("session_shutdown", () => {
		manager?.destroy();
		manager = null;
	});
}
