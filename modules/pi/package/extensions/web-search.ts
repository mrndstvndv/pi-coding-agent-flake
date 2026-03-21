import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createTimedSignal, DEFAULT_SEARCH_TIMEOUT_MS, truncateOutput } from "./web-tools.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_LIVECRAWL_MODE = "fallback" as const;
const DEFAULT_SEARCH_TYPE = "auto" as const;
const DEFAULT_CONTEXT_MAX_CHARACTERS = 10_000;

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(Type.Number({ description: "Number of search results to return (default: 8)" })),
  livecrawl: Type.Optional(
    Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
      description:
        "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling",
    }),
  ),
  type: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
      description: "Search type - 'auto': balanced search, 'fast': quick results, 'deep': comprehensive search",
    }),
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({ description: "Maximum characters for context string optimized for LLMs (default: 10000)" }),
  ),
});

interface McpSearchRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: {
      query: string;
      numResults?: number;
      livecrawl?: "fallback" | "preferred";
      type?: "auto" | "fast" | "deep";
      contextMaxCharacters?: number;
    };
  };
}

interface McpSearchResponse {
  jsonrpc: string;
  result?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with Exa and return the most relevant result context for current or recent information.",
    parameters: webSearchSchema,
    renderCall(args, theme) {
      const query = args.query.length > 60 ? `${args.query.slice(0, 57)}...` : args.query;
      return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${query}"`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

      const details = result.details as { query?: string; empty?: boolean; truncated?: boolean } | undefined;
      const content = result.content[0];

      if (details?.empty) {
        return new Text(theme.fg("muted", "No results found"), 0, 0);
      }

      const output = content?.type === "text" ? content.text : "";
      const allLines = output.split("\n");
      const lineCount = allLines.filter((l) => l.trim()).length;

      let text = theme.fg("success", `${lineCount} lines`);
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
    async execute(_toolCallId, params, signal, onUpdate) {
      const numResults = params.numResults ?? DEFAULT_NUM_RESULTS
      const livecrawl = params.livecrawl ?? DEFAULT_LIVECRAWL_MODE
      const type = params.type ?? DEFAULT_SEARCH_TYPE
      const contextMaxCharacters = params.contextMaxCharacters ?? DEFAULT_CONTEXT_MAX_CHARACTERS

      onUpdate?.({ content: [{ type: "text", text: `Searching the web for "${params.query}"...` }] })

      const { signal: requestSignal, clearTimeout, timedOut } = createTimedSignal(DEFAULT_SEARCH_TIMEOUT_MS, signal)

      try {
        const request: McpSearchRequest = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query: params.query,
              numResults,
              livecrawl,
              type,
              contextMaxCharacters,
            },
          },
        }

        const response = await fetch(EXA_MCP_URL, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: requestSignal,
        })

        if (!response.ok) {
          const errorText = await readResponseText(response)
          throw new Error(`Search error (${response.status}): ${errorText}`)
        }

        const responseText = await response.text()
        const resultText = parseSearchResponseText(responseText)
        if (!resultText) {
          return {
            content: [{ type: "text", text: "No search results found. Please try a different query." }],
            details: {
              query: params.query,
              numResults,
              livecrawl,
              type,
              contextMaxCharacters,
              empty: true,
            },
          }
        }

        const output = truncateOutput(resultText)
        return {
          content: [{ type: "text", text: output.content }],
          details: {
            query: params.query,
            numResults,
            livecrawl,
            type,
            contextMaxCharacters,
            truncated: output.truncation?.truncated ?? false,
            truncation: output.truncation,
          },
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(timedOut() ? "Search request timed out" : "Search request aborted")
        }

        throw error
      } finally {
        clearTimeout()
      }
    },
  })
}

function parseSearchResponseText(responseText: string): string | undefined {
  for (const line of responseText.split(/\r?\n/)) {
    const data = parseSseDataLine(line)
    if (!data) {
      continue
    }

    const resultText = extractResultText(data)
    if (resultText) {
      return resultText
    }
  }

  return undefined
}

function parseSseDataLine(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return undefined
  }

  const payload = trimmed.slice(5).trimStart()
  if (!payload || payload === "[DONE]") {
    return undefined
  }

  try {
    return JSON.parse(payload) as unknown
  } catch {
    return undefined
  }
}

function extractResultText(value: unknown): string | undefined {
  if (!isMcpSearchResponse(value)) {
    return undefined
  }

  const content = value.result?.content
  if (!content) {
    return undefined
  }

  return content.find((chunk) => chunk.type === "text" && typeof chunk.text === "string")?.text
}

function isMcpSearchResponse(value: unknown): value is McpSearchResponse {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  if (typeof record.jsonrpc !== "string") {
    return false
  }

  if (!("result" in record) || record.result === undefined) {
    return true
  }

  return isSearchResult(record.result)
}

function isSearchResult(value: unknown): value is NonNullable<McpSearchResponse["result"]> {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  if (!("content" in record) || record.content === undefined) {
    return true
  }

  if (!Array.isArray(record.content)) {
    return false
  }

  return record.content.every((chunk) => isSearchContentChunk(chunk))
}

function isSearchContentChunk(value: unknown): value is { type?: string; text?: string } {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  if ("type" in record && record.type !== undefined && typeof record.type !== "string") {
    return false
  }

  if ("text" in record && record.text !== undefined && typeof record.text !== "string") {
    return false
  }

  return true
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}
