import { formatSize, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import TurndownService from "turndown";
import {
  createTimedSignal,
  DEFAULT_FETCH_TIMEOUT_SECONDS,
  isHtmlLikeMimeType,
  isHttpUrl,
  isImageMimeType,
  MAX_FETCH_RESPONSE_BYTES,
  MAX_FETCH_TIMEOUT_SECONDS,
  normalizeMimeType,
  stripHtmlToText,
  truncateOutput,
} from "./web-tools.js";

type WebFetchFormat = "markdown" | "text" | "html";

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
  format: Type.Optional(
    Type.Union(
      [Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")],
      { description: "The format to return the content in (text, markdown, or html). Defaults to markdown." },
    ),
  ),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)" })),
});

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "pi";
const DEFAULT_ACCEPT_HEADERS: Record<WebFetchFormat, string> = {
  markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
  html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
};

const markdownConverter = createMarkdownConverter();

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return markdown, plain text, HTML, or an image attachment. Blocks oversized responses and converts HTML to markdown with Turndown.",
    parameters: webFetchSchema,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      text += theme.fg("accent", args.url);
      if (args.format && args.format !== "markdown") {
        text += theme.fg("dim", ` (${args.format})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

      const details = result.details as { url?: string; image?: boolean; truncated?: boolean; bytes?: number } | undefined;

      if (details?.image) {
        return new Text(theme.fg("success", "Image loaded"), 0, 0);
      }

      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const allLines = output.split("\n");
      const lineCount = allLines.filter((l) => l.trim()).length;

      let text = theme.fg("success", `${lineCount} lines`);
      if (details?.bytes) {
        text += theme.fg("dim", ` (${formatSize(details.bytes)})`);
      }
      if (details?.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      const displayLines = expanded ? allLines : allLines.slice(0, 5);
      for (const line of displayLines) {
        text += `\n${theme.fg("dim", line)}`;
      }
      if (!expanded) {
        const remaining = allLines.length - 5;
        if (remaining > 0) {
          text += `\n${theme.fg("muted", `... ${remaining} more lines (ctrl+o to expand)`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      if (!isHttpUrl(params.url)) {
        throw new Error("URL must start with http:// or https://")
      }

      const format = params.format ?? "markdown"
      const timeoutSeconds = clampTimeoutSeconds(params.timeout ?? DEFAULT_FETCH_TIMEOUT_SECONDS)
      const { signal: requestSignal, clearTimeout, timedOut } = createTimedSignal(timeoutSeconds * 1000, signal)

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }] })

      try {
        const response = await fetchWithChallengeRetry(params.url, requestSignal, format)

        if (!response.ok) {
          const errorText = await readResponseText(response)
          const suffix = errorText ? `: ${errorText}` : ""
          throw new Error(`Request failed with status code: ${response.status}${suffix}`)
        }

        const contentType = response.headers.get("content-type") ?? ""
        const mimeType = normalizeMimeType(contentType)
        const contentLength = response.headers.get("content-length")

        if (contentLength && Number.parseInt(contentLength, 10) > MAX_FETCH_RESPONSE_BYTES) {
          throw new Error(`Response too large (exceeds ${formatSize(MAX_FETCH_RESPONSE_BYTES)} limit)`)
        }

        const arrayBuffer = await response.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_FETCH_RESPONSE_BYTES) {
          throw new Error(`Response too large (exceeds ${formatSize(MAX_FETCH_RESPONSE_BYTES)} limit)`)
        }

        if (isImageMimeType(mimeType)) {
          const content = Buffer.from(arrayBuffer).toString("base64")
          return {
            content: [
              { type: "text", text: `Fetched image from ${params.url}` },
              { type: "image", data: content, mimeType },
            ],
            details: {
              url: params.url,
              format,
              contentType,
              mimeType,
              bytes: arrayBuffer.byteLength,
              image: true,
            },
          }
        }

        const text = new TextDecoder().decode(arrayBuffer)
        const output = convertContent(text, contentType, mimeType, format)

        return {
          content: [{ type: "text", text: output.content }],
          details: {
            url: params.url,
            format,
            contentType,
            mimeType,
            bytes: arrayBuffer.byteLength,
            truncated: output.truncation?.truncated ?? false,
            truncation: output.truncation,
          },
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(timedOut() ? "Request timed out" : "Request aborted")
        }

        throw error
      } finally {
        clearTimeout()
      }
    },
  })
}

function clampTimeoutSeconds(timeoutSeconds: number): number {
  return Math.min(Math.max(timeoutSeconds, 1), MAX_FETCH_TIMEOUT_SECONDS)
}

function createMarkdownConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  service.remove(["script", "style", "meta", "link"])
  return service
}

async function fetchWithChallengeRetry(url: string, signal: AbortSignal, format: WebFetchFormat): Promise<Response> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: DEFAULT_ACCEPT_HEADERS[format],
    "Accept-Language": "en-US,en;q=0.9",
  }

  const initialResponse = await fetch(url, { signal, headers })
  if (initialResponse.status !== 403 || initialResponse.headers.get("cf-mitigated") !== "challenge") {
    return initialResponse
  }

  return fetch(url, {
    signal,
    headers: {
      ...headers,
      "User-Agent": HONEST_USER_AGENT,
    },
  })
}

function convertContent(content: string, contentType: string, mimeType: string, format: WebFetchFormat): {
  content: string;
  truncation?: TruncationResult;
} {
  if (format === "html") {
    return truncateOutput(content)
  }

  if (!isHtmlLikeMimeType(mimeType) && !contentType.includes("text/html")) {
    return truncateOutput(content)
  }

  if (format === "markdown") {
    return truncateOutput(markdownConverter.turndown(content))
  }

  return truncateOutput(stripHtmlToText(content))
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}
