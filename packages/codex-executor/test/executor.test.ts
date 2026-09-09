import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionResult, createAction, createCharter, createMachine, createNode, createSourceInstance, createState, runMachine, tool, type ExecutorRunRequest, type FrameMessage } from "@projectors/core";
import { z } from "zod";
import { CodexExecutor } from "../src/index.ts";
import { CodexHost, type AppServer, type ServerMessage } from "../src/host.ts";
import { type Json, type Projection } from "../src/protocol.ts";

class FakeServer implements AppServer {
  listeners = new Set<(m: ServerMessage) => void>();
  requests: { method: string; params: any }[] = [];
  responses: any[] = [];
  next = 0;
  thread = "";
  turn = "";
  closed = false;
  onTurn?: () => void;
  onResponse?: (value: any) => void;
  pending = new Map<number, { thread: string; turn: string }>();
  emit(m: ServerMessage) { for (const l of this.listeners) l(m); }
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === "config/read") return { config: { mcp_servers: { personal: { enabled: true } } } };
    if (method === "thread/start") { this.thread = `thread-${crypto.randomUUID()}`; return { thread: { id: this.thread } }; }
    if (method === "thread/resume") { this.thread = params.threadId; return { thread: { id: this.thread } }; }
    if (method === "turn/start") {
      this.turn = `turn-${++this.next}`;
      this.emit({ method: "turn/started", params: { threadId: this.thread, turn: { id: this.turn } } });
      queueMicrotask(() => this.onTurn ? this.onTurn() : this.complete());
      return { turn: { id: this.turn } };
    }
    if (method === "turn/interrupt") { this.complete("interrupted"); return {}; }
    throw new Error(`Unexpected method ${method}`);
  }
  call(name: string, args: unknown) {
    const id = ++this.next;
    this.pending.set(id, { thread: this.thread, turn: this.turn });
    this.emit({ id, method: "item/tool/call", params: { threadId: this.thread, turnId: this.turn, callId: `call-${id}`, tool: "endograph_call", arguments: { name, arguments: args } } });
  }
  complete(status = "completed") {
    this.emit({ method: "item/completed", params: { threadId: this.thread, turnId: this.turn, item: { id: `answer-${this.turn}`, type: "agentMessage", text: "settled" } } });
    this.emit({ method: "turn/completed", params: { threadId: this.thread, turn: { id: this.turn, status } } });
  }
  respond(id: string | number, result: unknown) {
    const context = this.pending.get(Number(id));
    this.pending.delete(Number(id));
    this.responses.push(result);
    queueMicrotask(() => {
      if (context) { this.thread = context.thread; this.turn = context.turn; }
      this.onResponse?.(result);
    });
  }
  subscribe(l: (m: ServerMessage) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async close() { this.closed = true; }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function setup(stateDir?: string, committed = true) {
  const directory = stateDir ?? mkdtempSync(join(tmpdir(), "endo-codex-test-"));
  if (!stateDir) cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const server = new FakeServer();
  const host = new CodexHost({ stateDir: directory, server, isActivationCommitted: () => committed });
  cleanup.push(() => host.close());
  const executor = new CodexExecutor((input, emit, signal) => host.handle(input, signal ?? new AbortController().signal, emit ?? (() => {})));
  return { directory, server, host, executor };
}
function request(activationId: string, messages: FrameMessage[] = []): ExecutorRunRequest {
  return { activationId, generatorId: "generator", inference: { preamble: [{ type: "text", text: "Tend this system.", slot: "instructions", volatile: false }], history: [...messages], recency: [], tools: [], retrievableStates: [] },
    enqueueFrame(frame) { messages.push(...frame.messages ?? []); return { id: crypto.randomUUID(), ...frame }; } };
}
async function drive(executor: CodexExecutor, input: ExecutorRunRequest) {
  const staged: FrameMessage[] = [];
  const enqueue = input.enqueueFrame;
  input.enqueueFrame = (frame) => { staged.push(...frame.messages ?? []); return enqueue(frame); };
  for (let step = 0; step < 20; step++) {
    const result = await executor.run(input);
    if (result.completionReason !== "continue") return result;
    input = { ...input, activationId: `${input.activationId}:next`, continuationState: result.continuationState,
      inference: { ...input.inference, history: [...input.inference.history, ...staged.splice(0)] } };
  }
  throw new Error("Executor did not finish");
}

test("successive activations reuse a thread, append state changes, and tolerate projected history compaction", async () => {
  const { executor, server } = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "first event" }];
  await executor.run(request("first", messages));
  messages.push({ type: "user", text: "second event" });
  const second = request("second", messages);
  second.inference.recency = [{ type: "text", text: "State: deployed", slot: "state", volatile: true }];
  await executor.run(second);
  await executor.run(request("compacted", [{ type: "user", text: "Summary: both events settled" }]));
  expect(server.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  const turns = server.requests.filter((r) => r.method === "turn/start");
  expect(turns[1]!.params.input[0].text).toContain("second event");
  expect(turns[1]!.params.input[0].text).not.toContain("first event");
  expect(turns[1]!.params.input[0].text).toContain("State: deployed");
  expect(turns[2]!.params.input[0].text).toContain("Summary:");
  const config = server.requests.find((r) => r.method === "thread/start")!.params.config;
  expect(config["mcp_servers.personal.enabled"]).toBe(false);
  expect(config["features.shell_tool"]).toBe(false);
});

test("clean host restart resumes the thread; a different generator gets its own thread", async () => {
  const first = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "remember this" }];
  await first.executor.run(request("first", messages));
  const id = first.server.thread;
  await first.host.close();
  const second = setup(first.directory);
  await second.executor.run(request("second", [...messages, { type: "user", text: "continue" }]));
  expect(second.server.requests.find((r) => r.method === "thread/resume")?.params.threadId).toBe(id);
  await second.executor.run({ ...request("other"), generatorId: "other" });
  expect(second.server.thread).not.toBe(id);
});

test("actions validate args, use current capabilities, emit Projector frames, and stop on terminal results", async () => {
  const { executor, server } = setup();
  let effects = 0;
  const action = createAction({ state: null, name: "finish", inputSchema: z.object({ value: z.number() }), run() { effects++; return actionResult({ value: "done", terminal: true }); } });
  const messages: FrameMessage[] = [];
  const input = request("actions", messages);
  input.inference.tools = [action];
  server.onTurn = () => server.call("finish", { value: "invalid" });
  server.onResponse = () => {
    if (server.responses.length === 1) server.call("removed", {});
    if (server.responses.length === 2) server.call("finish", { value: 1 });
  };
  const result = await drive(executor, input);
  expect(effects).toBe(1);
  expect(server.responses.map((r) => r.success)).toEqual([false, false, true]);
  expect(messages.some((m) => m.type === "action" && m.kind === "result" && m.success === false)).toBe(true);
  expect(result.completionReason).toBe("terminal-action");
  expect(server.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
  expect(server.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
});

test("cancellation interrupts the native turn and an uncheckpointed session is not resumed", async () => {
  const first = setup();
  const abort = new AbortController();
  first.server.onTurn = () => abort.abort();
  expect((await first.executor.run({ ...request("cancelled"), signal: abort.signal })).completionReason).toBe("cancelled");
  const id = first.server.thread;
  await first.host.close();
  const second = setup(first.directory);
  await second.executor.run(request("next"));
  expect(second.server.requests.some((r) => r.method === "thread/resume")).toBe(false);
  expect(second.server.thread).not.toBe(id);
});

test("a turn completed without a worker checkpoint is uncertain after restart", async () => {
  const first = setup();
  const projection: Projection = { preamble: "[]", history: [], recency: "[]", tools: [] };
  await first.host.handle({ op: "run", generatorId: "generator", activationId: "uncommitted", projection } as Json, new AbortController().signal, () => {});
  await first.host.close();
  const second = setup(first.directory);
  await second.executor.run(request("recovery"));
  expect(second.server.requests.some((r) => r.method === "thread/resume")).toBe(false);
});

test("worker checkpoint cannot substitute for a durable Projector completion", async () => {
  const first = setup();
  await first.executor.run(request("staged-only"));
  await first.host.close();
  const second = setup(first.directory, false);
  await second.executor.run(request("recovery"));
  expect(second.server.requests.some((r) => r.method === "thread/resume")).toBe(false);
});

test("native tool responses wait for Projector state commits without starting another Codex turn", async () => {
  const { executor, server } = setup();
  const count = createState({ key: "count", schema: z.number(), init: 0, projection: { render: (n) => `counter:${n}` } });
  const increment = createAction({ state: count, name: "increment", inputSchema: z.object({}), run(_args, context) {
    const next = context.state! + 1;
    context.updateState!({ op: "replace", value: next });
    return next;
  } });
  const node = createNode({ key: "counter", instructions: "Increment twice.", states: [count], parts: [tool(increment)], runtime: { type: "generator", trigger: { type: "actor-frame" } } });
  const charter = createCharter({ nodes: [node], actions: [increment], states: [count] });
  const machine = createMachine({ charter, executor, instance: createSourceInstance({ id: "counter", node }) });
  server.onTurn = () => server.call("increment", {});
  server.onResponse = (result) => {
    const n = server.responses.length;
    expect(result.contentItems[0].text).toContain(`counter:${n}`);
    if (n === 1) server.call("increment", {});
    else server.complete();
  };
  machine.enqueueFrame({ messages: [{ type: "user", text: "Go" }] });
  for await (const _ of runMachine(machine)) void _;
  expect(machine.instance.states?.count?.value).toBe(2);
  expect(server.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  expect(server.requests.some((r) => r.method === "turn/interrupt")).toBe(false);
});

test("different generators can park tool results and resume their own native turns", async () => {
  const { executor, server } = setup();
  const echo = createAction({ state: null, name: "echo", inputSchema: z.object({}), run: () => "echoed" });
  const first = request("one");
  first.inference.tools = [echo];
  const second = { ...request("two"), generatorId: "other" };
  second.inference.tools = [echo];
  server.onTurn = () => server.call("echo", {});
  server.onResponse = () => server.complete();
  const one = await executor.run(first);
  const two = await executor.run(second);
  expect(one.completionReason).toBe("continue");
  expect(two.completionReason).toBe("continue");
  expect(server.responses).toHaveLength(0);
  expect((await executor.run({ ...first, activationId: "one-next", continuationState: one.continuationState })).completionReason).toBe("done");
  expect((await executor.run({ ...second, activationId: "two-next", continuationState: two.continuationState })).completionReason).toBe("done");
  expect(server.requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
});
