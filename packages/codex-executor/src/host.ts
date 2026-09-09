import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioAppServer, type AppServer, type ServerMessage } from "./app-server.ts";
import { contextUpdate, cursor, digest, type Cursor } from "./context.ts";
import { DYNAMIC_TOOLS, INSTRUCTIONS, json, object, requestSchema, type Json, type Projection, type RunInput, type ToolResult } from "./protocol.ts";
export type { AppServer, ServerMessage } from "./app-server.ts";

export interface CodexHostOptions {
  stateDir: string;
  /** Verify that the worker's staged outputs actually reached the durable frame log. */
  isActivationCommitted(activationId: string): boolean;
  model?: string;
  command?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  maxToolCalls?: number;
  /** Dependency injection for offline protocol tests. */
  server?: AppServer;
}
interface Session { version: 1; threadId: string; cursor?: Cursor; pending?: string; activationId?: string; model?: string; usage?: Record<string, number> }
interface Active {
  input: RunInput; session: Session; projection: Projection; emit(event: Json): void;
  resolve(value: Json): void; reject(error: Error): void;
  turnId?: string; stopped: boolean; terminal: boolean; calls: number; text: Map<string, string>;
  usage?: any; startedAt: number;
  tools: Map<string, { id: string | number; callId: string }>;
  continuation: string;
  waiting: boolean;
  response?: { id: string | number; success: boolean; text: string; observed: string[] };
  queued: ServerMessage[];
}

/** Trusted-side session owner. It accepts IR and tool results, never worker-selected commands/config. */
export class CodexHost {
  private server: AppServer;
  private cwd: string;
  private config?: Record<string, Json>;
  private sessions = new Map<string, Session>();
  private loaded = new Set<string>();
  private active = new Map<string, Active>();
  private starting = false;
  private closed = false;
  private unsubscribe: () => void;
  constructor(private options: CodexHostOptions) {
    this.cwd = mkdtempSync(join(tmpdir(), "endograph-codex-"));
    this.server = options.server ?? new StdioAppServer({ command: options.command, cwd: this.cwd });
    this.unsubscribe = this.server.subscribe((m) => this.onMessage(m));
  }
  async handle(raw: Json, signal: AbortSignal, emit: (event: Json) => void): Promise<Json> {
    const input = requestSchema.parse(raw);
    if (this.closed) throw new Error("Codex host is closed");
    signal.throwIfAborted();
    if (input.op === "tool-result") return this.toolResult(input);
    if (input.op === "checkpoint") {
      const session = this.sessions.get(input.generatorId);
      if (!session || session.pending !== input.activationId || this.active.has(input.generatorId)) throw new Error("No matching completed Codex activation");
      session.cursor = cursor(input.projection, input.observed);
      session.activationId = input.activationId;
      delete session.pending;
      this.save(input.generatorId, session);
      return null;
    }
    if (this.starting) throw new Error("Codex host already has an active executor step");
    this.starting = true;
    try {
      let active = this.active.get(input.generatorId);
      if (active?.stopped) { this.active.delete(input.generatorId); active = undefined; }
      if (active) {
        if (input.continuation !== active.continuation || !active.waiting) throw new Error("Codex turn requires its matching continuation");
        return await this.continue(active, input, signal, emit);
      }
      // A continuation restored after process death has no live native turn.
      // The pending marker causes a new thread, seeded from committed Projector IR.
      return await this.run(input, signal, emit);
    } finally { this.starting = false; }
  }
  private save(generator: string, session: Session) {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.options.stateDir, `${digest(generator)}.json`);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(session), { mode: 0o600 });
      const fd = openSync(temp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(this.options.stateDir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    finally { rmSync(temp, { force: true }); }
  }
  private read(generator: string): Session | undefined {
    try {
      const value = JSON.parse(readFileSync(join(this.options.stateDir, `${digest(generator)}.json`), "utf8"));
      if (value.version === 1 && typeof value.threadId === "string" && !value.pending && typeof value.activationId === "string"
        && value.model === this.options.model && this.options.isActivationCommitted(value.activationId)) return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async threadConfig() {
    if (this.config) return this.config;
    const config: Record<string, Json> = {
      "web_search": "disabled", "project_doc_max_bytes": 0,
      "features.shell_tool": false, "features.unified_exec": false, "features.shell_snapshot": false,
      "features.view_image": false, "features.apps": false, "features.plugins": false,
      "features.hooks": false, "features.multi_agent": false, "features.multi_agent_v2": false,
      "features.browser_use": false, "features.computer_use": false, "features.image_generation": false,
      "features.code_mode.enabled": false, "features.code_mode_host": false,
      "features.memories": false, "features.goals": false, "features.sleep_tool": false,
      "features.skip_host_skill_discovery": true,
    };
    const response = await this.server.request("config/read", { cwd: this.cwd, includeLayers: false });
    // Config maps merge by key; an empty mcp_servers table does not disable inherited servers.
    for (const name of Object.keys(response.config?.mcp_servers ?? {})) config[`mcp_servers.${name}.enabled`] = false;
    return this.config = config;
  }
  private async run(input: RunInput, signal: AbortSignal, emit: (event: Json) => void): Promise<Json> {
    const config = await this.threadConfig();
    signal.throwIfAborted();
    let session = this.sessions.get(input.generatorId) ?? this.read(input.generatorId);
    // An uncertain turn may already have performed effects. Never replay its native calls.
    if (session?.pending) session = undefined;
    const settings = { model: this.options.model, cwd: this.cwd, sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: INSTRUCTIONS, config, environments: [] };
    if (session && !this.loaded.has(session.threadId)) {
      try { await this.server.request("thread/resume", { ...settings, threadId: session.threadId }); }
      catch (error) {
        // Only missing rollouts justify a fresh session. Auth/transport failures must surface.
        if (!/thread.*not found|no rollout|failed to load rollout/i.test(String(error))) throw error;
        session = undefined;
      }
    }
    if (!session) {
      const result = await this.server.request("thread/start", { ...settings, dynamicTools: DYNAMIC_TOOLS });
      if (typeof result.thread?.id !== "string") throw new Error("Codex did not return a thread id");
      session = { version: 1, threadId: result.thread.id, model: this.options.model };
    }
    this.loaded.add(session.threadId);
    this.sessions.set(input.generatorId, session);
    signal.throwIfAborted();
    session.pending = input.activationId;
    this.save(input.generatorId, session);
    const completion = Promise.withResolvers<Json>();
    const active: Active = { input, session, projection: input.projection, emit, ...completion,
      stopped: false, terminal: false, calls: 0, text: new Map(), tools: new Map(), startedAt: Date.now(),
      continuation: crypto.randomUUID(), waiting: false, queued: [] };
    this.active.set(input.generatorId, active);
    // The completion event can arrive before the turn/start response.
    const resultTask = completion.promise;
    void resultTask.catch(() => {});
    return this.step(active, signal, resultTask, async () => {
      const result = await this.server.request("turn/start", { threadId: session.threadId,
        input: [{ type: "text", text: `Endograph activation ${input.activationId}\n${contextUpdate(input.projection, session.cursor)}` }],
        ...(this.options.effort ? { effort: this.options.effort } : {}), ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}) });
      active.turnId ??= result.turn?.id;
    });
  }
  private async continue(active: Active, input: RunInput, signal: AbortSignal, emit: (event: Json) => void): Promise<Json> {
    const response = active.response!;
    const update = contextUpdate(input.projection, cursor(active.projection, response.observed));
    const completion = Promise.withResolvers<Json>();
    Object.assign(active, completion, { input, emit, projection: input.projection, waiting: false, response: undefined });
    active.session.pending = input.activationId;
    this.save(input.generatorId, active.session);
    return this.step(active, signal, completion.promise, async () => {
      this.server.respond(response.id, { success: response.success, contentItems: [{ type: "inputText", text: response.text + (update === "{}" ? "" : `\nEndograph context update:\n${update}`) }] });
      const queued = active.queued.shift();
      if (queued) this.onMessage(queued);
    });
  }
  private async step(active: Active, signal: AbortSignal, completion: Promise<Json>, start: () => Promise<void>): Promise<Json> {
    const abort = () => { void this.interrupt(active); };
    signal.addEventListener("abort", abort, { once: true });
    void completion.catch(() => {});
    try {
      await start();
      if (signal.aborted || active.terminal) await this.interrupt(active);
      return await completion;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!active.waiting) {
        active.stopped = true;
        this.active.delete(active.input.generatorId);
      }
    }
  }
  private async interrupt(active: Active) {
    if (active.stopped || !active.turnId) return;
    try {
      await this.server.request("turn/interrupt", { threadId: active.session.threadId, turnId: active.turnId });
      // A successful interrupt request still needs its completion event. Bound that wait.
      const timer = setTimeout(() => { if (!active.stopped) { active.reject(new Error("Codex interruption did not complete")); void this.close(); } }, 5000);
      timer.unref();
    } catch (error) { active.reject(error instanceof Error ? error : new Error(String(error))); await this.close(); }
  }
  private toolResult(input: ToolResult): Json {
    const active = [...this.active.values()].find((a) => a.tools.has(input.token));
    const pending = active?.tools.get(input.token);
    if (!active || !pending || active.stopped) throw new Error("Unknown or completed Codex tool call");
    active.tools.delete(input.token);
    if (input.terminal) {
      active.terminal = true;
      this.server.respond(pending.id, { success: input.success, contentItems: [{ type: "inputText", text: input.text }] });
      void this.interrupt(active);
    } else {
      // Projector applies staged state/topology frames when run() returns.
      // Hold the native response until the next executor step supplies that IR.
      active.waiting = true;
      active.response = { id: pending.id, success: input.success, text: input.text, observed: input.observed };
      active.resolve({ status: "continue", continuation: active.continuation });
    }
    return null;
  }
  private onMessage(message: ServerMessage) {
    if (message.method === "endograph/disconnected") { for (const active of this.active.values()) active.reject(new Error(message.params.message)); return; }
    const p = message.params ?? {};
    const active = [...this.active.values()].find((a) => a.session.threadId === p.threadId);
    if (message.id !== undefined && message.method) {
      if (message.method !== "item/tool/call" || !active || active.stopped || p.threadId !== active.session.threadId) {
        // No unattended approval/user-input paths; these are not Endograph capabilities.
        this.server.respond(message.id, message.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
          : message.method.includes("requestApproval") ? { decision: "decline" }
          : message.method === "item/tool/requestUserInput" ? { answers: {} }
          : { success: false, contentItems: [{ type: "inputText", text: "Use Endograph actions; this capability is unavailable." }] });
        return;
      }
      if (active.terminal) {
        this.server.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "The activation has ended." }] });
        return;
      }
      if (active.waiting || active.tools.size) { active.queued.push(message); return; }
      active.turnId ??= p.turnId;
      if (++active.calls > (this.options.maxToolCalls ?? 40)) {
        this.server.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "Activation tool limit reached." }] });
        active.reject(new Error("Codex activation tool limit reached"));
        void this.close();
      } else if (p.tool === "endograph_list_actions") {
        this.server.respond(message.id, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(active.projection.tools) }] });
      } else if (p.tool === "endograph_call" && object(p.arguments) && typeof p.arguments.name === "string" && object(p.arguments.arguments)) {
        const token = crypto.randomUUID();
        active.tools.set(token, { id: message.id, callId: p.callId });
        active.emit(json({ type: "tool", token, callId: p.callId, name: p.arguments.name, arguments: p.arguments.arguments }));
      } else this.server.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "Unknown tool or invalid arguments." }] });
      return;
    }
    if (!active || p.threadId !== active.session.threadId) return;
    if (p.turnId && active.turnId && p.turnId !== active.turnId) return;
    if (message.method === "turn/started") active.turnId = p.turn.id;
    if (message.method === "item/completed" && p.item?.type === "agentMessage" && p.item.phase !== "commentary") active.text.set(p.item.id, p.item.text);
    if (message.method === "thread/tokenUsage/updated") active.usage = p.tokenUsage;
    if (message.method === "turn/completed") {
      active.stopped = true;
      const total = active.usage?.total;
      const usage = total ? Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens"].map((key) => [key, Math.max(0, total[key] - (active.session.usage?.[key] ?? 0))])) : undefined;
      if (total) active.session.usage = total;
      active.resolve(json({ status: p.turn.status, error: p.turn.error?.message ?? null, text: [...active.text.values()].join("\n\n"),
        execution: { model: this.options.model, latencyMs: Date.now() - active.startedAt, threadId: active.session.threadId, turnId: p.turn.id,
          ...(usage ? { usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens } } : {}) } }));
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) active.reject(new Error("Codex host closed"));
    await this.server.close();
    this.unsubscribe();
    rmSync(this.cwd, { recursive: true, force: true });
  }
}
