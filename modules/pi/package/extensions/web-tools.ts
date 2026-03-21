import { formatSize, truncateHead, type TruncationResult } from "@mariozechner/pi-coding-agent";

export const MAX_FETCH_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_SECONDS = 30;
export const MAX_FETCH_TIMEOUT_SECONDS = 120;
export const DEFAULT_SEARCH_TIMEOUT_MS = 25_000;

export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function createTimedSignal(timeoutMs: number, parentSignal?: AbortSignal): {
  signal: AbortSignal;
  clearTimeout: () => void;
  timedOut: () => boolean;
} {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  if (!parentSignal) {
    return {
      signal: timeoutController.signal,
      clearTimeout: () => globalThis.clearTimeout(timeoutId),
      timedOut: () => timedOut,
    };
  }

  const signal = AbortSignal.any([parentSignal, timeoutController.signal]);
  return {
    signal,
    clearTimeout: () => globalThis.clearTimeout(timeoutId),
    timedOut: () => timedOut,
  };
}

export function normalizeMimeType(contentType: string | null): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml" && mimeType !== "image/vnd.fastbidsheet";
}

export function isHtmlLikeMimeType(mimeType: string): boolean {
  return mimeType.includes("html") || mimeType.includes("xhtml");
}

export function truncateOutput(content: string): {
  content: string;
  truncation?: TruncationResult;
} {
  const truncation = truncateHead(content);
  if (!truncation.truncated) {
    return { content };
  }

  return {
    content: `${truncation.content}\n\n[Output truncated to ${formatSize(truncation.maxBytes)}]`,
    truncation,
  };
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function stripHtmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(stripped)
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITIES[entity] ?? match;
  });
}
