/**
 * Pi-side ACP Client
 * 
 * Lazily spawns a configurable ACP server process and manages ephemeral sessions
 * via NDJSON over stdin/stdout.
 */

import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";

// ============================================================================
// Types (mirrored from @agentclientprotocol/sdk)
// ============================================================================

export const PROTOCOL_VERSION = 1;

export interface AcpRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

export interface AcpResponse {
  jsonrpc?: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AcpNotification {
  method: string;
  params?: unknown;
}

export interface InitializeResult {
  protocolVersion: number;
  authMethods: AuthMethod[];
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
  };
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string | null;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select";
  currentValue: string;
  options: Array<{
    value: string;
    name: string;
    description?: string | null;
  }>;
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: SessionConfigOption[];
}

export interface SetSessionConfigOptionResult {
  configOptions: SessionConfigOption[];
}

export interface McpServerConfig {
  name: string;
  type?: "sse" | "http";
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "audio"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; mimeType?: string; name?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface PromptResult {
  stopReason: "end_turn" | "cancelled" | "error";
  text: string;
}

export interface SessionUpdate {
  sessionId: string;
  update: SessionUpdateEvent;
}

export type SessionUpdateEvent =
  | { sessionUpdate: "user_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      title: string;
      content: unknown[];
      kind?: string;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: "completed" | "failed";
      content: unknown[];
    };

// ============================================================================
// Error Classes
// ============================================================================

export class AcpError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpConnectionError";
  }
}

// ============================================================================
// AcpClient
// ============================================================================

export interface AcpClientOptions {
  /** Command to spawn the ACP server (default: "gemini") */
  command?: string;
  /** Arguments to pass to the command (default: []) */
  args?: string[];
  /** Working directory for new sessions */
  cwd: string;
  /** Authentication method ID to use (optional - will auto-detect if not provided) */
  authMethod?: string;
  /** Environment variables for the spawned process */
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Generic ACP (Agent Client Protocol) client.
 * 
 * Lazily spawns a configurable server process on first use and reuses it for multiple
 * ephemeral sessions. Each session is isolated and cleaned up after use.
 */
export class AcpClient {
  private options: Required<AcpClientOptions>;
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private sessionTextBuffers = new Map<string, string[]>();
  private requestId = 0;
  private initialized = false;
  private authenticated = false;
  private sessions = new Set<string>();

  constructor(options: AcpClientOptions) {
    this.options = {
      cwd: options.cwd,
      command: options.command ?? "gemini",
      args: options.args ?? [],
      authMethod: options.authMethod ?? "",
      env: options.env,
    };
  }

  /**
   * Check if the client is connected and ready
   */
  get isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get the number of active sessions
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Lazily spawn the ACP process
   */
  private async spawn(): Promise<void> {
    if (this.isConnected) return;

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ...this.options.env,
      };

      this.process = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: this.options.cwd,
      });

      if (!this.process.stdin || !this.process.stdout) {
        reject(new AcpConnectionError(`Failed to spawn ${this.options.command}: stdio not available`));
        return;
      }

      // Handle stderr for errors only
      this.process.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && (msg.includes("error") || msg.includes("Error"))) {
          console.error(`[acp-client] ${msg}`);
        }
      });

      // Handle process exit
      this.process.on("exit", (code) => {
        this.cleanup("Process exited with code " + code);
      });

      this.process.on("error", (err) => {
        reject(new AcpConnectionError(`Failed to spawn ${this.options.command}: ${err.message}`));
      });

      // Set up NDJSON line reader
      this.rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line) => this.handleLine(line));
      this.rl.on("close", () => this.cleanup("Readline closed"));
      this.rl.on("error", (err) => this.cleanup(`Readline error: ${err.message}`));

      // Wait for process to start
      setTimeout(resolve, 100);
    });
  }

  /**
   * Handle incoming NDJSON line
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      // Handle responses (with id)
      if (message.id !== undefined) {
        this.handleResponse(message as AcpResponse);
        return;
      }

      // Handle notifications (no id)
      if (message.method) {
        this.handleNotification(message as AcpNotification);
        return;
      }
    } catch (err) {
      console.error("[acp-client] Failed to parse message:", line);
    }
  }

  /**
   * Handle RPC response
   */
  private handleResponse(response: AcpResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new AcpError(response.error.code, response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle server notification
   */
  private handleNotification(notification: AcpNotification): void {
    if (notification.method === "session/update" || notification.method === "sessionUpdate") {
      const update = notification.params as SessionUpdate;
      this.handleSessionUpdate(update);
    }
  }

  /**
   * Handle session update - collect text chunks
   */
  private handleSessionUpdate(update: SessionUpdate): void {
    const { sessionId, update: event } = update;
    
    // Collect agent message chunks for text output
    if (event.sessionUpdate === "agent_message_chunk" && event.content?.type === "text") {
      const buffers = this.sessionTextBuffers.get(sessionId);
      if (buffers) {
        buffers.push(event.content.text);
      }
    }
  }

  /**
   * Send a request and wait for response
   */
  private async request(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    await this.spawn();

    const id = String(++this.requestId);
    const request: AcpRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AcpError(-32000, `Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { method, resolve, reject, timeout });

      const line = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          clearTimeout(timeout);
          reject(new AcpConnectionError(`Failed to send request: ${err.message}`));
        }
      });
    });
  }

  /**
   * Initialize the ACP connection
   */
  async initialize(): Promise<InitializeResult> {
    if (this.initialized) {
      throw new AcpError(-32600, "Already initialized");
    }

    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }) as InitializeResult;

    this.initialized = true;
    return result;
  }

  /**
   * Authenticate with the specified method
   */
  async authenticate(methodId?: string): Promise<void> {
    if (!this.initialized) {
      throw new AcpError(-32600, "Not initialized. Call initialize() first.");
    }
    if (this.authenticated) {
      return;
    }

    const authMethod = methodId || this.options.authMethod;
    if (!authMethod) {
      throw new AcpError(-32602, "No authentication method specified");
    }

    await this.request("authenticate", { methodId: authMethod }, 60000);
    this.authenticated = true;
  }

  /**
   * Ensure client is initialized and authenticated
   */
  async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.authenticated) {
      await this.authenticate();
    }
  }

  /**
   * Create a new ephemeral session
   */
  async newSession(mcpServers?: McpServerConfig[]): Promise<Session> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.request("session/new", {
      cwd: this.options.cwd,
      mcpServers: mcpServers || [],
    }) as NewSessionResult;

    this.sessions.add(result.sessionId);
    this.sessionTextBuffers.set(result.sessionId, []);

    return new Session(
      result.sessionId,
      this,
      result.configOptions ?? [],
      () => {
        this.sessions.delete(result.sessionId);
        this.sessionTextBuffers.delete(result.sessionId);
      }
    );
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SetSessionConfigOptionResult> {
    if (!this.sessions.has(sessionId)) {
      throw new AcpError(-32602, `Session not found: ${sessionId}`);
    }

    return this.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    }) as Promise<SetSessionConfigOptionResult>;
  }

  /**
   * Send a prompt to a session and collect text response
   */
  async prompt(
    sessionId: string,
    parts: PromptPart[],
    onChunk?: (text: string) => void
  ): Promise<PromptResult> {
    if (!this.sessions.has(sessionId)) {
      throw new AcpError(-32602, `Session not found: ${sessionId}`);
    }

    // Clear previous text buffer
    this.sessionTextBuffers.set(sessionId, []);
    
    // Track accumulated text
    let fullText = "";
    const chunkCallback = onChunk;

    // Temporarily replace the update handler to capture chunks for this session
    const handleUpdate = (update: SessionUpdate) => {
      const { sessionId: sid, update: event } = update;
      
      if (sid === sessionId && event.sessionUpdate === "agent_message_chunk" && event.content?.type === "text") {
        fullText += event.content.text;
        
        // Also update the buffer for consistency
        const buffers = this.sessionTextBuffers.get(sessionId);
        if (buffers) {
          buffers.push(event.content.text);
        }
        
        // Call the streaming callback if provided
        if (chunkCallback) {
          try {
            chunkCallback(fullText);
          } catch {
            // Ignore callback errors
          }
        }
      }
    };

    // Store original handler
    const originalHandler = this.handleSessionUpdate.bind(this);
    
    // Replace with combined handler
    this.handleSessionUpdate = (update: SessionUpdate) => {
      originalHandler(update);
      handleUpdate(update);
    };

    try {
      const result = await this.request("session/prompt", { sessionId, prompt: parts }, 300000) as { 
        stopReason: string;
        text?: string;
      };
      
      return {
        stopReason: result.stopReason as "end_turn" | "cancelled" | "error",
        text: fullText || result.text || "",
      };
    } finally {
      // Restore original handler
      this.handleSessionUpdate = originalHandler;
    }
  }

  /**
   * Cancel the current prompt in a session
   */
  async cancel(sessionId: string): Promise<void> {
    await this.request("session/cancel", { sessionId });
  }

  /**
   * Clean up all sessions and terminate the process
   */
  async shutdown(): Promise<void> {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new AcpError(-32000, "Client shutting down"));
    }
    this.pendingRequests.clear();

    this.sessions.clear();
    this.sessionTextBuffers.clear();

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }

    this.cleanup("Shutdown requested");
  }

  /**
   * Internal cleanup
   */
  private cleanup(reason: string): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.process = null;
    this.initialized = false;
    this.authenticated = false;

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new AcpConnectionError(`Connection closed: ${reason}`));
    }
    this.pendingRequests.clear();
  }
}

// ============================================================================
// Session - Represents a single ephemeral session
// ============================================================================

export class Session {
  constructor(
    public readonly id: string,
    private client: AcpClient,
    public configOptions: SessionConfigOption[],
    private onDispose: () => void
  ) {}

  /**
   * Send a prompt and wait for completion with full text response
   * @param onChunk - Optional callback for streaming text updates
   */
  async prompt(parts: PromptPart[], onChunk?: (text: string) => void): Promise<PromptResult> {
    return this.client.prompt(this.id, parts, onChunk);
  }

  /**
   * Update a session configuration option, e.g. model or mode.
   */
  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    const result = await this.client.setConfigOption(this.id, configId, value);
    this.configOptions = result.configOptions;
    return this.configOptions;
  }

  /**
   * Cancel the current prompt
   */
  async cancel(): Promise<void> {
    return this.client.cancel(this.id);
  }

  /**
   * Dispose of this session
   */
  dispose(): void {
    this.onDispose();
  }
}

// ============================================================================
// Factory / Pool for Pi Integration
// ============================================================================

export interface AcpPoolOptions {
  /** Command to spawn the ACP server */
  command?: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Authentication method ID to use */
  authMethod?: string;
  /** Environment variables for the spawned process */
  env?: NodeJS.ProcessEnv;
}

/**
 * Manages a shared ACP client instance for Pi handoffs.
 */
export interface AcpPool {
  /** Get or create the shared client */
  getClient(): Promise<AcpClient>;
  /** Create a new ephemeral session */
  newSession(mcpServers?: McpServerConfig[]): Promise<Session>;
  /** Shutdown the pool and cleanup */
  shutdown(): Promise<void>;
  /** Whether this is the first time the pool is being used */
  isFirstUse: boolean;
}

/**
 * Creates a shared ACP client pool for managing sessions.
 * Lazily initializes on first use and reuses connections.
 */
export function createAcpPool(options: AcpPoolOptions & { cwd: string }): AcpPool {
  let client: AcpClient | null = null;
  let hasBeenUsed = false;

  return {
    get isFirstUse() {
      return !hasBeenUsed;
    },

    async getClient(): Promise<AcpClient> {
      if (!client) {
        client = new AcpClient({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          authMethod: options.authMethod,
          env: options.env,
        });
      }
      return client;
    },

    async newSession(mcpServers?: McpServerConfig[]): Promise<Session> {
      hasBeenUsed = true;
      const c = await this.getClient();
      return c.newSession(mcpServers);
    },

    async shutdown(): Promise<void> {
      if (client) {
        await client.shutdown();
        client = null;
      }
      hasBeenUsed = false;
    },
  };
}
