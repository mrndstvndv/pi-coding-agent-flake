/**
 * OpenCode Zen — Free Model Access
 *
 * Registers the OpenCode Zen provider with free models.
 * Uses public anonymous access when OPENCODE_API_KEY is not set (free models only).
 * Set OPENCODE_API_KEY to unlock paid models on the same endpoint.
 *
 * Free models available (verified via API):
 *   - minimax-m2.5-free (MiniMax M2.5 Free) - 204.8K context, 131K output, reasoning
 *   - trinity-large-preview-free (Trinity Large Preview Free) - 128K context, 131K output
 *   - nemotron-3-super-free (Nemotron 3 Super Free) - 1M context, 128K output, reasoning
 *   - mimo-v2-flash-free (MiMo V2 Flash Free) - 262K context, 65K output, reasoning
 *   - mimo-v2-pro-free (MiMo V2 Pro Free) - 1M context, 64K output, reasoning
 *   - mimo-v2-omni-free (MiMo V2 Omni Free) - 262K context, 64K output, reasoning
 *
 * Note: OpenCode's models-api.json lists additional "-free" models, but only
 * these six are accessible via the public API without authentication.
 *
 * Usage: /model → opencode/minimax-m2.5-free
 */

import type { ExtensionAPI, ExtensionContext, AgentStartEvent } from "@mariozechner/pi-coding-agent"
import { randomBytes } from "crypto"
import { execSync } from "child_process"

// Generate OpenCode-compatible session ID
// Format: ses_<6byte_timestamp_hex><14byte_random_base62>
function generateSessionID(): string {
  const LENGTH = 26
  const timestamp = Date.now()
  const timeComponent = BigInt(timestamp) * BigInt(0x1000)
  
  // Convert time to hex (6 bytes)
  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((timeComponent >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  
  // Random base62 component
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let randomPart = ""
  const bytes = randomBytes(LENGTH - 12)
  for (let i = 0; i < LENGTH - 12; i++) {
    randomPart += chars[bytes[i] % 62]
  }
  
  return `ses_${timeBytes.toString("hex")}${randomPart}`
}

// Generate OpenCode-compatible request ID (for user messages)
// Format: usr_<6byte_timestamp_hex><14byte_random_base62>
function generateRequestID(): string {
  const LENGTH = 26
  const timestamp = Date.now()
  const timeComponent = BigInt(timestamp) * BigInt(0x1000)
  
  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((timeComponent >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let randomPart = ""
  const bytes = randomBytes(LENGTH - 12)
  for (let i = 0; i < LENGTH - 12; i++) {
    randomPart += chars[bytes[i] % 62]
  }
  
  return `usr_${timeBytes.toString("hex")}${randomPart}`
}

// Get project ID from git repo (root commit hash) or fallback
function getProjectID(cwd: string): string {
  try {
    // Try to get the root commit hash (first commit) - same as opencode
    const rootCommit = execSync(
      "git rev-list --max-parents=0 --all 2>/dev/null | head -1",
      { cwd, encoding: "utf8" }
    ).trim()
    
    if (rootCommit && rootCommit.length === 40) {
      return rootCommit
    }
  } catch {
    // Not a git repo or error
  }
  
  // Fallback: hash the cwd path to create a stable "global" ID
  const crypto = require("crypto")
  return crypto.createHash("sha1").update(cwd).digest("hex")
}

// Store IDs for the session
let sessionId: string | undefined
let projectId: string | undefined
let requestId: string | undefined

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.OPENCODE_API_KEY ?? "public"

  // Initialize on session start
  pi.on("session_start", (event, ctx) => {
    sessionId = generateSessionID()
    projectId = getProjectID(ctx.cwd)
  })

  // Generate new request ID before each agent turn
  pi.on("before_agent_start", (event: AgentStartEvent) => {
    requestId = generateRequestID()
  })

  pi.registerProvider("opencode", {
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey,
    api: "openai-completions",
    headers: {
      "User-Agent": "opencode/latest/0.0.0/cli",
      "HTTP-Referer": "https://opencode.ai",
      "X-Title": "opencode",
      "x-opencode-session": sessionId ?? generateSessionID(),
      "x-opencode-project": projectId ?? "global",
      "x-opencode-request": requestId ?? generateRequestID(),
      "x-opencode-client": "cli",
    },
    models: [
      {
        id: "minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        reasoning: true,
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
        id: "trinity-large-preview-free",
        name: "Trinity Large Preview Free",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 131072,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "nemotron-3-super-free",
        name: "Nemotron 3 Super Free",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "mimo-v2-flash-free",
        name: "MiMo V2 Flash Free",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "mimo-v2-pro-free",
        name: "MiMo V2 Pro Free",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 64000,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "mimo-v2-omni-free",
        name: "MiMo V2 Omni Free",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 64000,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  })
}
