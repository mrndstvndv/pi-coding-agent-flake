/**
 * Kilo Code — Free Frontier AI Access
 *
 * Registers the Kilo Code provider with free models from their OpenRouter-compatible API.
 * Uses anonymous/unauthenticated access by default - no API key required.
 * Available free models include:
 *   - kilo/auto-free (auto-routes to best free model)
 *   - minimax/minimax-m2.5:free
 *   - moonshotai/kimi-k2.5:free
 *   - giga-potato-thinking
 *
 * Set KILO_CODE_API_KEY to unlock paid/premium models.
 *
 * Usage: /model → kilocode/auto-free
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  // Use anonymous key for free tier, or allow custom API key for paid access
  const apiKey = process.env.KILO_CODE_API_KEY ?? "anonymous"

  pi.registerProvider("kilocode", {
    baseUrl: "https://api.kilo.ai/api/openrouter",
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: "kilo/auto-free",
        name: "Kilo Auto Free",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 204800,
        maxTokens: 131072,
        compat: {
          supportsDeveloperRole: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "minimax/minimax-m2.5:free",
        name: "MiniMax M2.5 Free",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 204800,
        maxTokens: 131072,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "moonshotai/kimi-k2.5:free",
        name: "Kimi K2.5 Free",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "giga-potato-thinking",
        name: "Giga Potato Thinking",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 32000,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  })
}
