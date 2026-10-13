/**
 * Command Code Provider
 *
 * Registers every model served by the Command Code Provider API
 * (https://commandcode.ai/docs/provider), discovered dynamically from
 * `GET https://api.commandcode.ai/provider/v1/models`.
 *
 * Transport is chosen per model from the API's `supported_endpoints` field:
 *   - "/messages"         -> anthropic-messages (baseUrl .../provider, SDK appends /v1/messages)
 *   - "/responses"        -> openai-responses   (baseUrl .../provider/v1)
 *   - "/chat/completions" -> openai-completions (baseUrl .../provider/v1)
 *
 * Auth reuses the CLI's own key: CMD_API_KEY if set, otherwise
 * ~/.commandcode/auth.json -> .apiKey. Both routes accept
 * `Authorization: Bearer <key>`; pi sends `x-api-key` on anthropic-messages,
 * which Command Code also accepts.
 *
 * The models endpoint exposes no reasoning/output-limit metadata, so family
 * heuristics fill the gaps. Claude metadata is taken verbatim from pi's built-in
 * catalog (pi-ai/dist/providers/data/anthropic.json), including which models
 * need adaptive thinking. DeepSeek takes its output limit from pi's deepseek
 * and opencode catalogs and its thinking levels from the endpoint's own enum;
 * every vision model gets the image resize bounds those catalogs declare.
 *
 * No pricing route exists either, so cost comes from the published table at
 * https://commandcode.ai/docs/resources/pricing-limits (USD per 1M tokens,
 * deals already applied). STATIC_PRICING is the generated snapshot; a network
 * /commandcode-refresh re-parses the live payload and the refreshed models are
 * persisted with their cost, so live rates survive restarts. Deals change
 * without notice, so a stored catalog keeps its old rates until a refresh.
 *
 * That same table carries `caps.vision` and `caps.reasoning` per model. A
 * refresh consumes them, so capability flags come from the docs rather than
 * from the id heuristics in familyMeta(), which apply only until first refresh.
 *
 * Models load from the persisted catalog or the static fallback below; network
 * discovery is manual via /commandcode-refresh, matching the opencode-free
 * extension. If a model ever lists /responses but rejects the OpenAI Responses
 * payload, add it to FORCE_COMPLETIONS_IDS or FORCE_COMPLETIONS_PATTERN.
 *
 * DeepSeek is populated there: with an image inside a tool result, /responses
 * intermittently answers 400 "The input is longer than the model's context
 * length" on some upstream routes, so those models stay on /chat/completions —
 * the same choice pi's own deepseek and opencode catalogs make.
 *
 * One known /responses quirk is handled in-place: pi always sends
 * `reasoning: { effort, summary }` when a thinking level is active, and Command
 * Code rejects `summary` ("json: unknown field \"summary\""). A
 * before_provider_request handler drops that one field; `effort` and `include`
 * are accepted, so reasoning still works.
 *
 * Usage: /model -> commandcode/<model id>   (ids may contain slashes)
 *        /commandcode-refresh   re-fetch the model catalog + pricing
 *        /commandcode-usage     credits + 5-hour/weekly limits
 */

import type { Api, Model, Usage } from "@mariozechner/pi-ai"
import type { ExtensionAPI, ProviderModelConfig, Theme, ThemeColor } from "@mariozechner/pi-coding-agent"
import { matchesKey, visibleWidth, type Focusable } from "@mariozechner/pi-tui"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CC_ORIGIN = "https://api.commandcode.ai"
const CC_API_BASE = `${CC_ORIGIN}/provider`
const CC_OPENAI_BASE = `${CC_API_BASE}/v1`
const CC_ANTHROPIC_BASE = CC_API_BASE
const CC_MODELS_URL = `${CC_OPENAI_BASE}/models`
const CC_PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const CC_ALPHA_BASE = `${CC_ORIGIN}/alpha`
const PROVIDER_ID = "commandcode"
const DEFAULT_MAX_TOKENS = 32000
const REFRESH_TIMEOUT_MS = 15000
const USAGE_TIMEOUT_MS = 10000

/** The Command Code API key, sourced from the CLI's own auth file. */
function resolveApiKey(): string | undefined {
  const env = process.env.CMD_API_KEY?.trim()
  if (env) return env
  try {
    const raw = readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && "apiKey" in parsed) {
      const key = (parsed as { apiKey?: unknown }).apiKey
      if (typeof key === "string" && key.length > 0) return key
    }
    return undefined
  } catch {
    return undefined
  }
}

interface CommandCodeModel {
  id: string
  name?: string
  context_length?: number
  supported_endpoints?: string[]
}

interface FamilyMeta {
  reasoning: boolean
  input: ("text" | "image")[]
  maxTokens: number
  thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"]
  compat?: ProviderModelConfig["compat"]
}

/**
 * Models that list /responses but misbehave there. DeepSeek is the known case:
 * on some upstream routes an image inside a tool result makes /responses answer
 * 400 "The input is longer than the model's context length", intermittently and
 * regardless of image size or output budget. pi's own deepseek and opencode
 * catalogs keep every DeepSeek model on chat completions, so these do too.
 * Add further ids here if verification finds another model rejecting /responses.
 */
const FORCE_COMPLETIONS_IDS = new Set<string>([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4.1-flash",
])
const FORCE_COMPLETIONS_PATTERN = /$^/

/** Offline fallback only: forces reasoning:false for a model that rejects reasoning parameters. */
const NON_REASONING_IDS = new Set<string>([])

/** Offline fallback only: vision-capable models missing from the family patterns below. */
const VISION_IDS = new Set<string>(["deepseek/deepseek-v4-flash-vision-exp"])

function claudeMeta(
  maxTokens: number,
  adaptive: boolean,
  thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"],
): FamilyMeta {
  return {
    reasoning: true,
    input: ["text", "image"],
    maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: {
      ...(adaptive ? { forceAdaptiveThinking: true } : {}),
      supportsStrictTools: true,
    },
  }
}

/** Claude metadata mirrored from pi's built-in anthropic catalog, keyed by exact id. */
const CLAUDE_META: Record<string, FamilyMeta> = {
  "claude-opus-5": claudeMeta(128000, true, { xhigh: "xhigh", max: "max" }),
  "claude-opus-4-8": claudeMeta(128000, true, { xhigh: "xhigh", max: "max" }),
  "claude-opus-4-7": claudeMeta(128000, true, { xhigh: "xhigh", max: "max" }),
  "claude-sonnet-5": claudeMeta(128000, true, { xhigh: "xhigh", max: "max" }),
  "claude-sonnet-4-6": claudeMeta(128000, true, { max: "max" }),
  "claude-fable-5": claudeMeta(128000, true, { off: null, xhigh: "xhigh", max: "max" }),
  "claude-fable-5-1": claudeMeta(128000, true, { off: null, xhigh: "xhigh", max: "max" }),
  "claude-haiku-4-5-20251001": claudeMeta(64000, false),
}

/**
 * DeepSeek metadata: the output limit comes from pi's deepseek and opencode
 * catalogs, the thinking levels from the endpoint's own enum.
 */
function deepseekMeta(): FamilyMeta {
  return {
    reasoning: true,
    input: ["text"],
    maxTokens: 384000,
    // api.commandcode.ai rejects developer-role requests past ~256Ki context
    // with 422 invalid_request_error; pi sends the system prompt as developer
    // for reasoning models unless this is false. Force system role.
    compat: { supportsDeveloperRole: false },
    // The endpoint accepts exactly these five levels and rejects every other
    // value, so `off` and `minimal` are declared unsupported. pi's catalogs
    // would also hide `medium` and `xhigh`, which the endpoint does accept.
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  }
}

/** Non-Claude defaults; unknown models are treated as reasoning text models. */
function familyMeta(id: string): FamilyMeta {
  if (NON_REASONING_IDS.has(id)) {
    return { reasoning: false, input: ["text"], maxTokens: DEFAULT_MAX_TOKENS }
  }
  if (/^gpt-/i.test(id)) {
    return { reasoning: true, input: ["text", "image"], maxTokens: 128000 }
  }
  if (/^deepseek\//i.test(id)) {
    const meta = deepseekMeta()
    return VISION_IDS.has(id) ? { ...meta, input: ["text", "image"] } : meta
  }
  if (/^(google\/gemini|meta\/muse|xai\/grok)/i.test(id)) {
    return { reasoning: true, input: ["text", "image"], maxTokens: DEFAULT_MAX_TOKENS }
  }
  if (VISION_IDS.has(id)) {
    return { reasoning: true, input: ["text", "image"], maxTokens: DEFAULT_MAX_TOKENS }
  }
  return { reasoning: true, input: ["text"], maxTokens: DEFAULT_MAX_TOKENS }
}

function metaFor(id: string): FamilyMeta {
  // pi's built-in anthropic catalog outranks the docs for Claude: it describes
  // the model the anthropic-messages transport is actually written against.
  if (CLAUDE_META[id]) return CLAUDE_META[id]
  if (/^claude-/i.test(id)) return claudeMeta(64000, true, { xhigh: "xhigh", max: "max" })

  const heuristics = familyMeta(id)
  const caps = capsFor(id)
  if (!caps) return heuristics
  const vision = caps.vision ?? heuristics.input.includes("image")
  return {
    ...heuristics,
    reasoning: caps.reasoning ?? heuristics.reasoning,
    input: vision ? ["text", "image"] : ["text"],
  }
}

/** Whether an id is pinned to /chat/completions whatever /responses claims. */
function forcesCompletions(id: string): boolean {
  return FORCE_COMPLETIONS_IDS.has(id) || FORCE_COMPLETIONS_PATTERN.test(id)
}

function pickApi(id: string, endpoints: string[]): { api: Api; baseUrl: string } {
  if (endpoints.includes("/messages")) {
    return { api: "anthropic-messages", baseUrl: CC_ANTHROPIC_BASE }
  }
  if (forcesCompletions(id)) {
    return { api: "openai-completions", baseUrl: CC_OPENAI_BASE }
  }
  if (endpoints.includes("/responses")) {
    return { api: "openai-responses", baseUrl: CC_OPENAI_BASE }
  }
  return { api: "openai-completions", baseUrl: CC_OPENAI_BASE }
}

/* ------------------------------------------------------------------ *
 * Cost tracking
 *
 * /provider/v1/models carries no rates and there is no pricing route, so
 * cost is scraped from the published table on the docs site (USD per 1M
 * tokens, deals already applied). STATIC_PRICING is a generated snapshot;
 * /commandcode-refresh replaces it in memory with the live table and pi
 * persists the refreshed models with their cost.
 *
 * pi's calculateCost() applies these rates itself. The one thing it cannot
 * express is DeepSeek's peak window, so a message_end handler reprices
 * peak-time turns.
 * ------------------------------------------------------------------ */

interface CostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
}

interface PricingBand extends CostRates {
  /** Total input tokens (`input + cacheRead + cacheWrite`) above which this band applies. */
  inputTokensAbove: number
}

interface Pricing extends CostRates {
  bands?: PricingBand[]
  /** DeepSeek peak-window rates; the base fields are off-peak. */
  peak?: CostRates
}

const STATIC_PRICING: Record<string, Pricing> = {
  "laguna-s-2.1-free": { input: 0, output: 0, cacheRead: 0 },
  "ling-3.0-flash-free": { input: 0, output: 0, cacheRead: 0 },
  "ling-3.0-flash-sante:free": { input: 0, output: 0, cacheRead: 0 },
  "tencent/hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042 },
  "tencent/hy3-paid": { input: 0.14, output: 0.58, cacheRead: 0.035 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19 },
  "kimi-k2.7-code-highspeed": { input: 1.9, output: 8, cacheRead: 0.38 },
  "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
  "glm-5.3-flashx": { input: 0.37, output: 1.25, cacheRead: 0.075 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.2-fast": { input: 3, output: 10.25, cacheRead: 0.5 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5": { input: 1, output: 3.2, cacheRead: 0.2 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.03 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
  "deepseek-v4-flash": { input: 0.15, output: 0.6, cacheRead: 0.003,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
  },
  "deepseek-v4-flash-vision-exp": { input: 0.15, output: 0.6, cacheRead: 0.003,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
  },
  "deepseek-v4-flash-fast": { input: 0.28, output: 0.56, cacheRead: 0.07 },
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
  },
  "qwen-3.8-omni-flash": { input: 0.15, output: 0.47, cacheRead: 0.016 },
  "qwen-3.8-max-0902": { input: 2, output: 6, cacheRead: 0.25 },
  "qwen-3.8-max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  "qwen-3.8-27b": { input: 0.4, output: 3, cacheRead: 0.04 },
  "qwen-3.6-max": { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
  "qwen-3.6-plus": { input: 0.5, output: 3, cacheRead: 0.1,
    bands: [
      { inputTokensAbove: 256000, input: 2, output: 6, cacheRead: 0.2 },
    ],
  },
  "qwen-3.7-max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
  "qwen-3.7-plus": { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5,
    bands: [
      { inputTokensAbove: 256000, input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 1.5 },
    ],
  },
  "qwen-3.8-flash": { input: 0.16, output: 0.47, cacheRead: 0.016 },
  "qwen-3.7-flash": { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038,
    bands: [
      { inputTokensAbove: 32000, input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.125 },
      { inputTokensAbove: 256000, input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 },
    ],
  },
  "longcat-2.0": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "step-5-preview": { input: 1, output: 2.7, cacheRead: 0.05 },
  "step-3.7-flash": { input: 0.2, output: 1.15, cacheRead: 0.04 },
  "step-3.5-flash": { input: 0.1, output: 0.3, cacheRead: 0.02 },
  "mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "nemotron-3-ultra": { input: 0.6, output: 2.4, cacheRead: 0.12 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
    bands: [
      { inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
    ],
  },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
    bands: [
      { inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
    ],
  },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5,
    bands: [
      { inputTokensAbove: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
    ],
  },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25,
    bands: [
      { inputTokensAbove: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
    ],
  },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15 },
  "gemini-3.7-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.08334 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.03 },
  "fugu-ultra": { input: 5, output: 30, cacheRead: 0.5 },
  "muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002 },
  "muse-spark-1.2": { input: 1.25, output: 4.25, cacheRead: 0.15 },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002 },
  "muse-spark-1.1": { input: 1.25, output: 4.25, cacheRead: 0.15 },
  "grok-4.7": { input: 1.2, output: 3.6, cacheRead: 0.3 },
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5,
    bands: [
      { inputTokensAbove: 200000, input: 4, output: 12, cacheRead: 1 },
    ],
  },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.5 },
  "inkling": { input: 1, output: 4.05, cacheRead: 0.17 },
  "inkling-small": { input: 0.5, output: 1.2, cacheRead: 0.1 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
}

/** Docs ids that don't normalize to their API model id. */
const PRICING_ID_OVERRIDES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "Qwen/Qwen3.6-Max-Preview": "qwen-3.6-max",
  "nvidia/nemotron-3-ultra-550b-a55b": "nemotron-3-ultra",
}

/** Case- and punctuation-insensitive key so docs and API ids line up. */
function normalizePricingId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9.]/g, "")
}

/**
 * Capability flags the docs table publishes next to each model's rates. Flags
 * the docs omit stay undefined so the id heuristics keep deciding.
 */
interface ModelCaps {
  vision?: boolean
  reasoning?: boolean
}

function buildIndex<T>(entries: Iterable<[string, T]>): Map<string, T> {
  const index = new Map<string, T>()
  for (const [id, value] of entries) index.set(normalizePricingId(id), value)
  return index
}

let pricingIndex = buildIndex(Object.entries(STATIC_PRICING))
/** Empty until a refresh loads the docs table; see metaFor(). */
let capsIndex = buildIndex<ModelCaps>([])

/**
 * Docs ids are namespaced differently from API ids, so try the override table,
 * the id as written, then its basename (`xai/grok-4.6` -> `grok-4.6`).
 */
function lookup<T>(index: Map<string, T>, modelId: string): T | undefined {
  const override = PRICING_ID_OVERRIDES[modelId]
  if (override) return index.get(normalizePricingId(override))
  const direct = index.get(normalizePricingId(modelId))
  if (direct) return direct
  return index.get(normalizePricingId(modelId.slice(modelId.lastIndexOf("/") + 1)))
}

function pricingFor(modelId: string): Pricing | undefined {
  return lookup(pricingIndex, modelId)
}

function capsFor(modelId: string): ModelCaps | undefined {
  return lookup(capsIndex, modelId)
}

function toModelCost(pricing: Pricing | undefined): ProviderModelConfig["cost"] {
  if (!pricing) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite ?? 0,
    ...(pricing.bands?.length
      ? {
          tiers: pricing.bands.map((band) => ({
            inputTokensAbove: band.inputTokensAbove,
            input: band.input,
            output: band.output,
            cacheRead: band.cacheRead,
            cacheWrite: band.cacheWrite ?? 0,
          })),
        }
      : {}),
  }
}

/** "≤ 512K" / "> 272K" -> 512000 / 272000. */
function contextLimit(context: unknown): number | undefined {
  if (typeof context !== "string") return undefined
  const match = /(\d+(?:\.\d+)?)\s*([KM])/i.exec(context)
  if (!match) return undefined
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return undefined
  return Math.round(value * (match[2].toUpperCase() === "M" ? 1_000_000 : 1_000))
}

function readRates(value: unknown): CostRates | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input)
  const output = asNumber(value.output)
  const cacheRead = asNumber(value.cacheRead)
  if (input === undefined || output === undefined || cacheRead === undefined) return undefined
  const cacheWrite = asNumber(value.cacheWrite)
  return cacheWrite === undefined ? { input, output, cacheRead } : { input, output, cacheRead, cacheWrite }
}

/** One `rows` entry: rates, capability flags, or both. */
interface DocsRow {
  id: string
  pricing?: Pricing
  caps?: ModelCaps
}

function parseCaps(row: Record<string, unknown>): ModelCaps | undefined {
  if (!isRecord(row.caps)) return undefined
  const caps: ModelCaps = {}
  if (typeof row.caps.vision === "boolean") caps.vision = row.caps.vision
  if (typeof row.caps.reasoning === "boolean") caps.reasoning = row.caps.reasoning
  return caps.vision === undefined && caps.reasoning === undefined ? undefined : caps
}

function parseDocsRow(row: unknown): DocsRow | undefined {
  if (!isRecord(row) || typeof row.id !== "string") return undefined
  const entry: DocsRow = { id: row.id }
  const pricing = parsePricingRow(row)
  if (pricing) entry.pricing = pricing
  const caps = parseCaps(row)
  if (caps) entry.caps = caps
  return entry.pricing || entry.caps ? entry : undefined
}

function parsePricingRow(row: Record<string, unknown>): Pricing | undefined {
  if (!Array.isArray(row.tiers) || row.tiers.length === 0) return undefined
  const tiers = row.tiers.filter(isRecord)
  const base = readRates(tiers[0]?.rates)
  if (!base) return undefined

  const pricing: Pricing = { ...base }
  const bands: PricingBand[] = []
  for (let index = 1; index < tiers.length; index++) {
    const threshold = contextLimit(tiers[index - 1]?.context)
    const rates = readRates(tiers[index]?.rates)
    if (threshold === undefined || !rates) continue
    bands.push({ inputTokensAbove: threshold, ...rates })
  }
  if (bands.length > 0) pricing.bands = bands

  const peak = readRates(isRecord(row.timeOfDay) ? row.timeOfDay.peak : undefined)
  if (peak) pricing.peak = peak
  return pricing
}

const RSC_CHUNK = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g

/** Next.js streams the docs data as escaped JSON chunks; join them back up. */
function extractRscPayload(html: string): string {
  const chunks: string[] = []
  for (const match of html.matchAll(RSC_CHUNK)) {
    try {
      chunks.push(JSON.parse(match[1]) as string)
    } catch {
      // Ignore malformed chunks; a complete payload still contains the rows array.
    }
  }
  return chunks.join("")
}

/** Read the JSON array starting at `marker`, tracking strings so brackets inside values don't count. */
function parseJsonArrayAt(text: string, marker: string): unknown[] | undefined {
  const markerStart = text.indexOf(marker)
  if (markerStart < 0) return undefined
  const start = markerStart + marker.length - 1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "[") depth++
    else if (char === "]") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown[]
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Best-effort scrape of the live docs table; callers fall back to STATIC_PRICING. */
async function fetchDocsTable(signal: AbortSignal): Promise<DocsRow[]> {
  const response = await fetch(CC_PRICING_URL, { signal, headers: { Accept: "text/html" } })
  if (!response.ok) throw new Error(`GET ${CC_PRICING_URL} -> ${response.status}`)

  const rows = parseJsonArrayAt(extractRscPayload(await response.text()), '"rows":[') ?? []
  const parsed = rows.map(parseDocsRow).filter((row): row is DocsRow => row !== undefined)
  if (parsed.length === 0) throw new Error("Command Code published no model rows")
  return parsed
}

/** DeepSeek peak: 01-04 and 06-10 UTC, Monday to Friday. */
function isPeakWindow(now: number): boolean {
  const date = new Date(now)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

function costFromRates(rates: CostRates, usage: Usage): Usage["cost"] {
  const input = (rates.input / 1e6) * usage.input
  const output = (rates.output / 1e6) * usage.output
  const cacheRead = (rates.cacheRead / 1e6) * usage.cacheRead
  const cacheWrite = ((rates.cacheWrite ?? 0) / 1e6) * usage.cacheWrite
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/**
 * Resize bounds pi's own catalogs declare for every vision model; without them
 * pi forwards screenshots at their original resolution.
 */
function imageInputLimits(): ProviderModelConfig["inputLimits"] {
  return { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } }
}

function toProviderModel(item: CommandCodeModel): ProviderModelConfig {
  const { api, baseUrl } = pickApi(item.id, item.supported_endpoints ?? [])
  const meta = metaFor(item.id)
  return {
    id: item.id,
    name: item.name ?? item.id,
    api,
    baseUrl,
    reasoning: meta.reasoning,
    input: meta.input,
    ...(meta.input.includes("image") ? { inputLimits: imageInputLimits() } : {}),
    cost: toModelCost(pricingFor(item.id)),
    contextWindow: item.context_length ?? 128000,
    maxTokens: meta.maxTokens,
    ...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
    compat: { supportsDeveloperRole: false, ...meta.compat },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseModels(payload: unknown): CommandCodeModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  const models: CommandCodeModel[] = []
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue
    models.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : undefined,
      context_length: typeof entry.context_length === "number" ? entry.context_length : undefined,
      supported_endpoints: Array.isArray(entry.supported_endpoints)
        ? entry.supported_endpoints.filter((value): value is string => typeof value === "string")
        : undefined,
    })
  }
  return models
}

async function fetchModels(signal: AbortSignal, apiKey: string | undefined): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  // The docs table is best-effort: a docs hiccup must not fail the model refresh.
  const [response, docs] = await Promise.all([
    fetch(CC_MODELS_URL, { signal, headers }),
    fetchDocsTable(signal).catch(() => undefined),
  ])
  if (!response.ok) throw new Error(`GET ${CC_MODELS_URL} -> ${response.status}`)

  const models = parseModels((await response.json()) as unknown)
  if (models.length === 0) throw new Error("Command Code listed no models")
  if (docs) {
    const rates = new Map<string, Pricing>()
    const caps = new Map<string, ModelCaps>()
    for (const row of docs) {
      if (row.pricing) rates.set(row.id, row.pricing)
      if (row.caps) caps.set(row.id, row.caps)
    }
    pricingIndex = buildIndex(rates)
    capsIndex = buildIndex(caps)
    pricingSource = "live"
  }
  return models.map(toProviderModel).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Snapshot used before the first successful refresh, so the provider registers
 * offline. Ids/shapes mirror /provider/v1/models.
 */
const FALLBACK_CATALOG: CommandCodeModel[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000, supported_endpoints: ["/messages"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1000000, supported_endpoints: ["/messages"] },
  { id: "claude-opus-5", name: "Claude Opus 5", context_length: 1000000, supported_endpoints: ["/messages"] },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", context_length: 1000000, supported_endpoints: ["/messages"] },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", context_length: 1000000, supported_endpoints: ["/messages"] },
  { id: "claude-fable-5", name: "Claude Fable 5", context_length: 1000000, supported_endpoints: ["/messages"] },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    context_length: 200000,
    supported_endpoints: ["/messages"],
  },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1050000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", context_length: 1050000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context_length: 1050000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", context_length: 400000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", context_length: 400000, supported_endpoints: ["/chat/completions", "/responses"] },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro (latest)",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (latest)",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  { id: "moonshotai/Kimi-K3", name: "Kimi K3", context_length: 1000000, supported_endpoints: ["/chat/completions", "/responses"] },
  {
    id: "moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    context_length: 256000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "Qwen/Qwen3.8-Max", name: "Qwen 3.8 Max", context_length: 1000000, supported_endpoints: ["/chat/completions", "/responses"] },
  {
    id: "stepfun/Step-5-Preview",
    name: "Step 5 Preview",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  { id: "xai/grok-4.7", name: "Grok 4.7", context_length: 500000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "xai/grok-4.6", name: "Grok 4.6", context_length: 500000, supported_endpoints: ["/chat/completions", "/responses"] },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  {
    id: "MiniMaxAI/MiniMax-M3",
    name: "MiniMax M3",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", context_length: 1000000, supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "meta/muse-spark-1.3", name: "Muse Spark 1.3", context_length: 1048576, supported_endpoints: ["/chat/completions", "/responses"] },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron 3 Ultra",
    context_length: 1000000,
    supported_endpoints: ["/chat/completions", "/responses"],
  },
]

/** Latest persisted, live, or fallback list. */
let currentModels: ProviderModelConfig[] = FALLBACK_CATALOG.map(toProviderModel)
let manualRefreshInProgress = false
/** Whether the live docs table replaced the bundled snapshot this process. */
let pricingSource: "static" | "live" = "static"

function hasCost(cost: ProviderModelConfig["cost"]): boolean {
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0
}

function restoreStoredModels(stored: { models: readonly Model<Api>[] } | undefined): ProviderModelConfig[] {
  return (stored?.models ?? [])
    .filter((model) => model.provider === PROVIDER_ID)
    .map(({ provider: _provider, ...model }) => {
      const restored = model as ProviderModelConfig
      // Catalogs persisted before cost tracking (or before a model was priced)
      // carry all-zero rates; re-price those from the current table.
      const cost = hasCost(restored.cost) ? restored.cost : toModelCost(pricingFor(restored.id))
      // Everything the code derives is re-applied on top of the stored entry: a
      // catalog keeps the transport, limits and level map it was fetched with,
      // so edits to pickApi()/metaFor() would otherwise stay dormant until the
      // next refresh. `input` stays as stored — it carries the vision flag the
      // docs supplied, which metaFor() cannot rebuild offline.
      const meta = metaFor(restored.id)
      const { api, baseUrl } = forcesCompletions(restored.id)
        ? { api: "openai-completions" as const, baseUrl: CC_OPENAI_BASE }
        : restored
      const vision = restored.input.includes("image") || meta.input.includes("image")
      return {
        ...restored,
        api,
        baseUrl,
        cost,
        // Stored catalogs predate the developer-role fix; force it here so a
        // /reload is enough without waiting for the next /commandcode-refresh.
        compat: { ...restored.compat, ...meta.compat, supportsDeveloperRole: false },
        maxTokens: meta.maxTokens,
        ...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
        ...(vision ? { inputLimits: imageInputLimits() } : {}),
      }
    })
}

/* ------------------------------------------------------------------ *
 * Usage limits (/commandcode-usage)
 *
 * The CLI's /usage renders these, and they are undocumented/alpha:
 *   GET /alpha/billing/credits       credit balance + 5-hour/weekly windows
 *   GET /alpha/billing/subscriptions plan id
 *   GET /alpha/usage/summary         billing-period totals
 * All authenticate with the same Bearer key.
 * ------------------------------------------------------------------ */

interface UsageWindow {
  used: number
  cap: number
  exceeded: boolean
  resetAt: number
}

interface UsageData {
  plan?: string
  monthlyCredits?: number
  purchasedCredits?: number
  freeCredits?: number
  fiveHour?: UsageWindow
  weekly?: UsageWindow
  requests?: number
  cost?: number
  successRate?: number
  tokensIn?: number
  tokensOut?: number
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined
  const used = asNumber(value.used)
  const cap = asNumber(value.cap)
  if (used === undefined || cap === undefined) return undefined
  return { used, cap, exceeded: value.exceeded === true, resetAt: asNumber(value.resetAt) ?? 0 }
}

/** "individual-goat" -> "GOAT" */
function prettifyPlan(planId: string): string {
  const name = planId
    .replace(/^individual[-_]/, "")
    .replace(/[-_]+/g, " ")
    .trim()
  return name ? name.toUpperCase() : planId
}

function parseOverview(raw: { credits: unknown; subscriptions: unknown; summary: unknown }): UsageData {
  const data: UsageData = {}

  if (isRecord(raw.credits)) {
    if (isRecord(raw.credits.credits)) {
      data.monthlyCredits = asNumber(raw.credits.credits.monthlyCredits)
      data.purchasedCredits = asNumber(raw.credits.credits.purchasedCredits)
      data.freeCredits = asNumber(raw.credits.credits.freeCredits)
    }
    if (isRecord(raw.credits.windowLimits)) {
      data.fiveHour = toWindow(raw.credits.windowLimits.fiveHour)
      data.weekly = toWindow(raw.credits.windowLimits.weekly)
    }
  }

  if (isRecord(raw.subscriptions) && isRecord(raw.subscriptions.data)) {
    const planId = raw.subscriptions.data.planId
    if (typeof planId === "string") data.plan = prettifyPlan(planId)
  }

  if (isRecord(raw.summary)) {
    data.requests = asNumber(raw.summary.totalCount)
    data.cost = asNumber(raw.summary.totalCost)
    data.successRate = asNumber(raw.summary.successRate)
    data.tokensIn = asNumber(raw.summary.totalTokensIn)
    data.tokensOut = asNumber(raw.summary.totalTokensOut)
  }

  return data
}

async function fetchOverview(apiKey: string, signal: AbortSignal): Promise<UsageData> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${CC_ALPHA_BASE}${path}`, {
      signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
    return (await response.json()) as unknown
  }

  // Only the credits endpoint is required; plan and period totals are best-effort.
  const [credits, subscriptions, summary] = await Promise.all([
    get("/billing/credits"),
    get("/billing/subscriptions").catch(() => undefined),
    get("/usage/summary").catch(() => undefined),
  ])
  return parseOverview({ credits, subscriptions, summary })
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

function compactCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return `${Math.round(value)}`
}

function formatReset(resetAt: number): string {
  const remaining = resetAt - Date.now()
  if (remaining <= 0) return "now"
  const minutes = Math.floor(remaining / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes % 60}m`
}

function windowPercent(window: UsageWindow): number {
  if (window.cap <= 0) return 0
  return Math.max(0, Math.min(100, (window.used / window.cap) * 100))
}

const METER_CELLS = 10

function meterBar(pct: number, theme: Theme): string {
  const filled = Math.round((pct / 100) * METER_CELLS)
  const color: ThemeColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success"
  return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(METER_CELLS - filled))
}

/** Single-line summary for non-UI modes. */
function formatOverviewText(data: UsageData): string {
  const lines = [data.plan ? `Command Code usage (${data.plan})` : "Command Code usage"]

  const credits: string[] = []
  if (data.monthlyCredits !== undefined) credits.push(`${money(data.monthlyCredits)} monthly`)
  if (data.purchasedCredits !== undefined) credits.push(`${money(data.purchasedCredits)} purchased`)
  if (data.freeCredits !== undefined) credits.push(`${money(data.freeCredits)} free`)
  if (credits.length > 0) lines.push(`Credits: ${credits.join(" · ")}`)

  if (data.fiveHour) {
    lines.push(`5-hour: ${windowPercent(data.fiveHour).toFixed(0)}% · resets in ${formatReset(data.fiveHour.resetAt)}`)
  }
  if (data.weekly) {
    lines.push(`Weekly: ${windowPercent(data.weekly).toFixed(0)}% · resets in ${formatReset(data.weekly.resetAt)}`)
  }
  if (data.requests !== undefined) {
    lines.push(
      `Period: ${data.requests} requests · ${money(data.cost ?? 0)} · ${(data.successRate ?? 0).toFixed(0)}% success`,
    )
  }
  return lines.join("\n")
}

/** Floating panel shown by /commandcode-usage. */
class UsageOverlay implements Focusable {
  readonly width = 62
  focused = false

  constructor(
    private readonly theme: Theme,
    private readonly data: UsageData,
    private readonly close: () => void,
  ) {}

  handleInput(input: string): void {
    if (matchesKey(input, "escape") || matchesKey(input, "return") || input === "q" || input === "Q") {
      this.close()
    }
  }

  private meterLine(label: string, window: UsageWindow): string {
    const th = this.theme
    const pct = windowPercent(window)
    const pctText = `${pct.toFixed(0)}%`.padStart(4)
    return `   ${th.fg("muted", label.padEnd(7))}${meterBar(pct, th)}  ${th.fg("text", pctText)}  ${th.fg("dim", `·  resets in ${formatReset(window.resetAt)}`)}`
  }

  render(_width: number): string[] {
    const th = this.theme
    const inner = this.width - 2
    const { data } = this

    const pad = (text: string, length: number): string =>
      text + " ".repeat(Math.max(0, length - visibleWidth(text)))
    const row = (content: string): string => th.fg("border", "│") + pad(content, inner) + th.fg("border", "│")
    const section = (title: string): string => row(` ${th.fg("muted", title.toUpperCase())}`)

    const lines: string[] = []
    lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`))
    const title = ` ${th.bold(th.fg("accent", "Command Code usage"))}`
    const plan = data.plan ? th.fg("dim", `  ·  ${data.plan}`) : ""
    lines.push(row(`${title}${plan}`))
    lines.push(row(""))

    lines.push(section("credits"))
    lines.push(row(`   ${pad(th.fg("muted", "monthly"), 11)}${th.fg("text", money(data.monthlyCredits ?? 0))}`))
    if (data.purchasedCredits !== undefined || data.freeCredits !== undefined) {
      const purchased = `${money(data.purchasedCredits ?? 0)} purchased`
      const free = `${money(data.freeCredits ?? 0)} free`
      lines.push(row(`   ${pad(th.fg("muted", "on demand"), 11)}${th.fg("text", purchased)}${th.fg("dim", `  ·  ${free}`)}`))
    }
    lines.push(row(""))

    if (data.fiveHour || data.weekly) {
      lines.push(section("usage limits"))
      if (data.fiveHour) lines.push(row(this.meterLine("5-hour", data.fiveHour)))
      if (data.weekly) lines.push(row(this.meterLine("Weekly", data.weekly)))
      lines.push(row(""))
    }

    if (data.requests !== undefined) {
      lines.push(section("this billing period"))
      const bits = [
        `${data.requests} requests`,
        money(data.cost ?? 0),
        `${(data.successRate ?? 0).toFixed(0)}% success`,
      ]
      lines.push(row(`   ${th.fg("text", bits.join("  ·  "))}`))
      if (data.tokensIn !== undefined || data.tokensOut !== undefined) {
        const tokens = `${compactCount(data.tokensIn ?? 0)} in  /  ${compactCount(data.tokensOut ?? 0)} out`
        lines.push(row(`   ${th.fg("dim", tokens)}`))
      }
      lines.push(row(""))
    }

    lines.push(row(` ${th.fg("dim", "Esc to close")}`))
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`))
    return lines
  }

  invalidate(): void {}
  dispose(): void {}
}

export default function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey()

  pi.registerProvider(PROVIDER_ID, {
    name: "Command Code",
    baseUrl: CC_OPENAI_BASE,
    api: "openai-completions",
    apiKey,
    // Register immediately; network discovery is manual via /commandcode-refresh.
    models: (currentModels = FALLBACK_CATALOG.map(toProviderModel)),
    refreshModels: async ({ signal, allowNetwork, stored, publish }) => {
      const restored = restoreStoredModels(stored)
      if (restored.length > 0) currentModels = restored

      // pi calls refreshModels during startup and when /model opens. Keep both
      // paths network-free; only the explicit command enables discovery.
      if (!allowNetwork || !manualRefreshInProgress) return currentModels

      const fetched = await fetchModels(signal, apiKey)
      if (signal.aborted) return currentModels

      const published = await publish({
        persist: {
          models: fetched.map((model) => ({ ...model, provider: PROVIDER_ID })),
          checkedAt: Date.now(),
          lastModified: 0,
        },
        update: () => {
          currentModels = fetched
        },
      })
      return published ? fetched : currentModels
    },
  })

  // Command Code's /responses endpoint rejects the OpenAI-standard
  // `reasoning.summary` field (400 "json: unknown field \"summary\""), which pi's
  // openai-responses transport sets whenever a reasoning effort is present.
  // Strip it so reasoning requests go through; `effort` and `include` are accepted.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return
    const payload = event.payload
    if (!isRecord(payload) || !isRecord(payload.reasoning) || !("summary" in payload.reasoning)) return
    const { summary: _summary, ...reasoning } = payload.reasoning
    return { ...payload, reasoning }
  })

  // pi's calculateCost() can't see DeepSeek's peak window, so reprice those turns.
  pi.on("message_end", (event) => {
    const message = event.message
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return
    const peak = pricingFor(message.model)?.peak
    if (!peak || !isPeakWindow(Date.now())) return
    return {
      message: { ...message, usage: { ...message.usage, cost: costFromRates(peak, message.usage) } },
    }
  })

  pi.registerCommand("commandcode-refresh", {
    description: "Refresh Command Code models and pricing",
    handler: async (_args, ctx) => {
      manualRefreshInProgress = true
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: [PROVIDER_ID],
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })
        if (result.aborted) {
          ctx.ui.notify("Command Code model refresh cancelled.", "warning")
          return
        }

        const error = result.errors.get(PROVIDER_ID)
        if (error) {
          ctx.ui.notify(`Command Code model refresh failed: ${error.message}`, "error")
          return
        }

        const pricing = pricingSource === "live" ? "live pricing" : "bundled pricing"
        ctx.ui.notify(`Command Code models refreshed (${currentModels.length}, ${pricing}).`, "info")
      } finally {
        manualRefreshInProgress = false
      }
    },
  })

  pi.registerCommand("commandcode-usage", {
    description: "Show Command Code credits and usage limits",
    handler: async (_args, ctx) => {
      if (!apiKey) {
        ctx.ui.notify("Command Code: no API key found (set CMD_API_KEY or log in with the CLI)", "error")
        return
      }

      let data: UsageData
      try {
        data = await fetchOverview(apiKey, AbortSignal.timeout(USAGE_TIMEOUT_MS))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Command Code usage fetch failed: ${message}`, "error")
        return
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(formatOverviewText(data), "info")
        return
      }

      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => new UsageOverlay(theme, data, () => done()),
        { overlay: true },
      )
    },
  })
}
