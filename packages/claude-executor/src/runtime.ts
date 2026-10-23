import { createSdkMcpServer, query, tool, type EffortLevel, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type NativeTool = "list_actions" | "call";
export interface ToolReply { success: boolean; text: string }
export interface TurnResult {
  ok: boolean;
  text: string;
  error?: string;
  model?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/** One live Claude Code conversation. At most one turn runs at a time. */
export interface NativeSession {
  /** False once the process has exited or failed; a saved conversation must be reopened. */
  readonly alive: boolean;
  /** Sends one user message; resolves with that turn's result. */
  turn(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface OpenOptions {
  sessionId: string;
  /** Continue a saved conversation rather than start one with this ID. */
  resume: boolean;
  outputSchema?: Record<string, unknown>;
  /** The only tools the conversation has; replies may wait on Projector. */
  call(tool: NativeTool, args: unknown): Promise<ToolReply>;
  /** Standing context to restore when Claude Code compacts this conversation, which keeps only its own summary. */
  restore(): string | undefined;
}
export interface ClaudeRuntime {
  open(options: OpenOptions): NativeSession;
}

export const SERVER = "endograph";
export const TOOL_NAMES = [`mcp__${SERVER}__list_actions`, `mcp__${SERVER}__call`];
// Claude Code truncates MCP tool results past 25k tokens by default, or saves them to a file this
// conversation has no tool to read. Action results and context updates arrive as tool results;
// the model's context window, not this cap, is their limit.
const MAX_TOOL_RESULT_TOKENS = "1000000";
// An enclosing Claude Code session's identity would make this a nested, unsaved child session.
const INHERITED = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"];

/** The Agent SDK's streaming-input mode: one Claude Code process per conversation, over stdio. */
export class SdkRuntime implements ClaudeRuntime {
  constructor(private options: { cwd: string; instructions: string; model?: string; effort?: EffortLevel; command?: string }) {}
  open(options: OpenOptions): NativeSession { return new SdkSession(this.options, options); }
}

class SdkSession implements NativeSession {
  private query: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private waiting?: { resolve(result: TurnResult): void; reject(error: Error): void };
  private failure?: Error;
  private closed = false;
  private model?: string;
  constructor(settings: SdkRuntime["options"], options: OpenOptions) {
    const reply = async (tool: NativeTool, args: unknown) => {
      const result = await options.call(tool, args);
      return { content: [{ type: "text" as const, text: result.text }], ...(result.success ? {} : { isError: true }) };
    };
    const server = createSdkMcpServer({ name: SERVER, alwaysLoad: true, tools: [
      tool("list_actions", "Get the current Endograph action names, descriptions and input schemas. Use before invoking an unfamiliar action.", {}, () => reply("list_actions", {})),
      tool("call", "Invoke a currently available Endograph action. Input is validated against its current schema; unavailable actions are refused.",
        // z.record silently empties the SDK server's tool list (SDK 0.3.280); a loose object is equivalent here.
        { name: z.string(), arguments: z.looseObject({}) }, (args) => reply("call", args)),
    ] });
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "endograph", MAX_MCP_OUTPUT_TOKENS: MAX_TOOL_RESULT_TOKENS };
    for (const key of INHERITED) delete env[key];
    this.query = query({ prompt: this.messages(), options: {
      cwd: settings.cwd, env, systemPrompt: settings.instructions,
      ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.command ? { pathToClaudeCodeExecutable: settings.command } : {}),
      // No built-in tools, filesystem settings, hooks, plugins, skills or other MCP servers:
      // every effect goes through Endograph actions in the worker.
      tools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: { [SERVER]: server },
      // Auto-memory ignores settingSources: it would load the owner's own Claude Code memory for this
      // repository as instructions. The agent's memory is its state and log.
      settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
      allowedTools: TOOL_NAMES, permissionPrompts: "none",
      ...(options.resume ? { resume: options.sessionId } : { sessionId: options.sessionId }),
      ...(options.outputSchema ? { outputFormat: { type: "json_schema", schema: options.outputSchema } } : {}),
      // Claude Code's own hook for context that must survive compaction; it runs as soon as compaction ends, mid-turn included.
      hooks: { SessionStart: [{ matcher: "compact", hooks: [async (input) => {
        const additionalContext = input.hook_event_name === "SessionStart" && input.source === "compact" ? options.restore() : undefined;
        return additionalContext ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } } : {};
      }] }] },
      // Diagnostics may echo inherited configuration; they are not surfaced.
      stderr: () => {},
    } });
    void this.pump();
  }
  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.inbox.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
  private async pump() {
    try {
      for await (const message of this.query) this.receive(message);
      this.fail(new Error("Claude Code exited"));
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private receive(message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") this.model = message.model;
    if (message.type !== "result") return;
    const waiting = this.waiting;
    this.waiting = undefined;
    // Projector counts all input tokens, cached ones included; Anthropic reports cache reads and writes separately.
    const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = message.usage;
    const usage = { inputTokens: input_tokens + cache_read_input_tokens + cache_creation_input_tokens, cachedInputTokens: cache_read_input_tokens, outputTokens: output_tokens };
    if (message.subtype === "success" && !message.is_error)
      waiting?.resolve({ ok: true, text: message.structured_output === undefined ? message.result : JSON.stringify(message.structured_output), model: this.model, usage });
    else waiting?.resolve({ ok: false, text: "", error: "errors" in message ? message.errors.join("\n") : message.result, model: this.model, usage });
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
  }
  get alive() { return !this.failure; }
  turn(text: string): Promise<TurnResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed || this.waiting) return Promise.reject(new Error("Claude Code session is busy or closed"));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      this.wake?.();
    });
  }
  async interrupt() { await this.query.interrupt(); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.fail(new Error("Claude Code session closed"));
    this.query.close();
  }
}
