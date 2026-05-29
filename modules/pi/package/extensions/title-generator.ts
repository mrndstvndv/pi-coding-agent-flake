/**
 * Auto-generates a session title from the first user prompt.
 * /title command regenerates using full conversation context.
 *
 * Uses Gemini 2.5 Flash Lite via ACP (same client as handoff).
 * System prompt adapted from OpenCode's title agent.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { createAcpPool, type AcpPool, type PromptPart } from "./acp-client.js";

const TITLE_MODEL = "gemini-2.5-flash-lite";

const SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`;

/** Global ACP pool shared across title generator calls */
let acpPool: AcpPool | null = null;

function getAcpPool(cwd: string): AcpPool {
  if (!acpPool) {
    const hasApiKey = !!process.env.GEMINI_API_KEY;
    acpPool = createAcpPool({
      cwd,
      command: "gemini",
      args: ["--model", TITLE_MODEL, "--acp"],
      authMethod: hasApiKey ? "gemini-api-key" : "oauth-personal",
      env: {
        GEMINI_CLI_DISABLE_SESSION_PERSISTENCE: "true",
      },
    });

    process.on("beforeExit", () => {
      acpPool?.shutdown().catch(() => {});
    });
  }
  return acpPool;
}

function findModelConfigId(
  configOptions: Array<{ id: string; category?: string | null }>
): string | null {
  const modelOption = configOptions.find((o) => o.category === "model");
  if (modelOption) return modelOption.id;
  const fallback = configOptions.find((o) => o.id === "model");
  return fallback?.id ?? null;
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return "Title generation failed.";
  const msg = error.message.toLowerCase();
  if (msg.includes("exhausted your daily quota") || msg.includes("quota")) {
    return "Gemini quota exceeded. Try again later.";
  }
  if (msg.includes("api key is missing")) {
    return "Gemini API key not configured. Set GEMINI_API_KEY or run 'gemini auth login'.";
  }
  return error.message;
}

/** Update loader message by accessing internal component */
function updateLoaderMessage(loader: BorderedLoader, message: string): void {
  const internal = loader as unknown as { loader: { setMessage: (m: string) => void } };
  internal.loader?.setMessage(message);
}

/** Extract text from a message's content array */
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ");
}

/** Gather limited conversation text (first N user messages) for auto-title */
function gatherFirstMessages(entries: SessionEntry[], max = 3): string {
  return entries
    .filter(
      (e): e is SessionEntry & { type: "message" } =>
        e.type === "message" && e.message.role === "user"
    )
    .slice(0, max)
    .map((e) => {
      if (e.type !== "message") return "";
      return extractText(e.message.content);
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Gather full conversation text for manual /title regeneration */
function gatherFullConversation(entries: SessionEntry[]): string {
  const messages = entries
    .filter(
      (e): e is SessionEntry & { type: "message" } => e.type === "message"
    )
    .map((e) => e.message);

  const llmMessages = convertToLlm(messages);
  return serializeConversation(llmMessages);
}

/**
 * Core title generation via ACP with BorderedLoader UI.
 * Mirrors handoff's UI pattern.
 */
async function generateTitleWithUI(
  conversationText: string,
  cwd: string,
  ui: any
): Promise<string | null> {
  const pool = getAcpPool(cwd);

  let lastError: string | null = null;

  const result = await ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
    const initialMessage = pool.isFirstUse ? "Connecting to Gemini..." : "Generating title...";
    const loader = new BorderedLoader(tui, theme, initialMessage);
    loader.onAbort = () => done(null);

    const updateMessage = (msg: string) => {
      updateLoaderMessage(loader, msg);
      tui.requestRender();
    };

    const doGenerate = async () => {
      updateMessage("Creating session...");
      const session = await pool.newSession();

      if (loader.signal?.aborted) {
        session.dispose();
        return null;
      }

      try {
        const modelConfigId = findModelConfigId(session.configOptions);
        if (modelConfigId) {
          const modelOption = session.configOptions
            .find((o) => o.id === modelConfigId)
            ?.options.find((o) => o.value === TITLE_MODEL);

          if (modelOption) {
            updateMessage("Selecting model...");
            await session.setConfigOption(modelConfigId, TITLE_MODEL);
          }
        }

        updateMessage("Generating...");

        const parts: PromptPart[] = [
          {
            type: "text",
            text: `${SYSTEM_PROMPT}\n\nGenerate a title for this conversation:\n${conversationText}`,
          },
        ];

        let streamedText = "";
        const promptResult = await session.prompt(parts, (chunk) => {
          streamedText = chunk;
          const preview = chunk.slice(-60).replace(/\s+/g, " ").trim();
          if (preview) updateMessage(preview);
        });

        if (promptResult.stopReason === "error") {
          throw new Error("Generation failed");
        }

        const finalText = promptResult.text || streamedText;
        if (!finalText?.trim()) {
          throw new Error("Empty response from Gemini");
        }

        return cleanTitle(finalText);
      } finally {
        session.dispose();
      }
    };

    doGenerate()
      .then(done)
      .catch((err) => {
        lastError = formatError(err);
        done(null);
      });

    return loader;
  });

  if (result === null && lastError) {
    ui.notify(lastError, "error");
  }

  return result;
}

/** Plain title generation without UI (for auto-title on agent_end) */
async function generateTitlePlain(
  conversationText: string,
  cwd: string
): Promise<string | null> {
  const pool = getAcpPool(cwd);
  const session = await pool.newSession();

  try {
    const parts: PromptPart[] = [
      {
        type: "text",
        text: `${SYSTEM_PROMPT}\n\nGenerate a title for this conversation:\n${conversationText}`,
      },
    ];

    const result = await session.prompt(parts);
    if (result.stopReason !== "end_turn" || !result.text?.trim()) return null;
    return cleanTitle(result.text);
  } finally {
    session.dispose();
  }
}

function cleanTitle(text: string): string {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!cleaned) return "";

  return cleaned.length > 60 ? cleaned.substring(0, 57) + "..." : cleaned;
}

export default function (pi: ExtensionAPI) {
  let titled = false;
  let titling = false;
  let lifecycleToken = 0;

  // Auto-title on first prompt (silent, no loader)
  pi.on("session_start", async (_event, ctx) => {
    lifecycleToken += 1;
    titled = false;
    titling = false;

    if (pi.getSessionName()) {
      titled = true;
      return;
    }

    const entries = ctx.sessionManager.getBranch();
    const hasUserMessages = entries.some(
      (e): e is SessionEntry & { type: "message" } =>
        e.type === "message" && e.message.role === "user"
    );
    if (hasUserMessages) titled = true;
  });

  pi.on("session_shutdown", () => {
    lifecycleToken += 1;
    titling = false;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (titled || titling) return;

    const entries = ctx.sessionManager.getBranch();
    const conversationText = gatherFirstMessages(entries);
    if (!conversationText.trim()) return;

    const token = lifecycleToken;
    titling = true;

    // Fire-and-forget: generate title in background without blocking next prompt.
    // Drop results if the session/runtime was replaced while generation was in flight.
    void generateTitlePlain(conversationText, ctx.cwd)
      .then((title) => {
        if (!title) return;
        if (token !== lifecycleToken) return;

        pi.setSessionName(title);
        titled = true;
      })
      .catch((err) => {
        console.error("[title-generator]", err);
        if (token !== lifecycleToken) return;

        try {
          ctx.ui?.notify?.(`Title generation failed: ${formatError(err)}`, "error");
        } catch {}
      })
      .finally(() => {
        if (token !== lifecycleToken) return;
        titling = false;
      });
  });

  // /title command — regenerate with full conversation + BorderedLoader UI
  pi.registerCommand("title", {
    description: "Regenerate session title from full conversation",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/title requires interactive mode", "error");
        return;
      }

      const entries = ctx.sessionManager.getBranch();
      if (entries.length === 0) {
        ctx.ui.notify("No conversation to title", "error");
        return;
      }

      const conversationText = gatherFullConversation(entries);
      if (!conversationText.trim()) {
        ctx.ui.notify("No text content found", "error");
        return;
      }

      const title = await generateTitleWithUI(conversationText, ctx.cwd, ctx.ui);
      if (title) {
        pi.setSessionName(title);
        titled = true;
        ctx.ui.notify(`Title: ${title}`, "success");
      }
    },
  });
}
