import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionResult, createAction, createCharter, createMachine, createNode, createSourceInstance, createState, runMachine, tool, type ExecutorRunRequest, type FrameMessage } from "@projectors/core";
import { z } from "zod";
import { NativeExecutor } from "@endograph/codex-executor";
import { ClaudeHost, type ClaudeRuntime, type NativeSession, type OpenOptions, type ToolReply, type TurnResult } from "../src/host.ts";

class FakeSession implements NativeSession {
  turns: string[] = [];
  waiting?: (result: TurnResult) => void;
  closed = false;
  exited = false;
  interrupted = 0;
  constructor(readonly runtime: FakeRuntime, readonly options: OpenOptions) {}
  get alive() { return !this.closed && !this.exited; }
  turn(text: string) {
    this.turns.push(text);
    if (this.exited) return Promise.reject(new Error("Claude Code process exited with code 137"));
    if (this.runtime.missing.has(this.options.sessionId)) return Promise.resolve({ ok: false, text: "", error: `No conversation found with session ID: ${this.options.sessionId}` });
    return new Promise<TurnResult>((resolve) => {
      this.waiting = resolve;
      queueMicrotask(() => this.runtime.onTurn ? this.runtime.onTurn(this) : this.complete());
    });
  }
  complete(result: Partial<TurnResult> = {}) {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ ok: true, text: "settled", model: "fixture", usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 }, ...result });
  }
  call(name: string, args: unknown) {
    return this.options.call("call", { name, arguments: args }).then((reply) => {
      this.runtime.responses.push(reply);
      queueMicrotask(() => this.runtime.onResponse?.(this, reply));
      return reply;
    });
  }
  async interrupt() { this.interrupted++; queueMicrotask(() => this.complete({ ok: false, error: "interrupted" })); }
  async close() { this.closed = true; }
}
class FakeRuntime implements ClaudeRuntime {
  sessions: FakeSession[] = [];
  responses: ToolReply[] = [];
  missing = new Set<string>();
  onTurn?: (session: FakeSession) => void;
  onResponse?: (session: FakeSession, reply: ToolReply) => void;
  open(options: OpenOptions) {
    const session = new FakeSession(this, options);
    this.sessions.push(session);
    return session;
  }
  get turns() { return this.sessions.flatMap((s) => s.turns); }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function setup(stateDir?: string) {
  const directory = stateDir ?? mkdtempSync(join(tmpdir(), "endo-claude-test-"));
  if (!stateDir) cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const host = new ClaudeHost({ stateDir: directory, runtime, isActivationCommitted: () => true });
  cleanup.push(() => host.close());
  const executor = new NativeExecutor((input, emit, signal) => host.handle(input, signal ?? new AbortController().signal, emit ?? (() => {})), "claude");
  return { directory, runtime, host, executor };
}
function request(activationId: string, messages: FrameMessage[] = []): ExecutorRunRequest {
  return { activationId, generatorId: "generator", inference: { preamble: [{ type: "text", text: "Tend this system.", slot: "instructions", volatile: false }], history: [...messages], recency: [], tools: [], retrievableStates: [] },
    enqueueFrame(frame) { messages.push(...frame.messages ?? []); return { id: crypto.randomUUID(), ...frame }; } };
}
async function drive(executor: NativeExecutor, input: ExecutorRunRequest) {
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

test("successive activations reuse one live session and send only context changes", async () => {
  const { executor, runtime } = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "first event" }];
  const first = await executor.run(request("first", messages));
  expect(first).toMatchObject({ completionReason: "done", execution: { model: "fixture", usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 } } });
  expect(executor.identity.name).toBe("claude");
  messages.push({ type: "user", text: "second event" });
  const second = request("second", messages);
  second.inference.recency = [{ type: "text", text: "State: deployed", slot: "state", volatile: true }];
  await executor.run(second);
  expect(runtime.sessions).toHaveLength(1);
  expect(runtime.sessions[0]!.options.resume).toBe(false);
  expect(runtime.turns[0]).toContain("Tend this system.");
  expect(runtime.turns[1]).toContain("second event");
  expect(runtime.turns[1]).not.toContain("first event");
  expect(runtime.turns[1]).not.toContain("Tend this system.");
  expect(runtime.turns[1]).toContain("State: deployed");
  expect(messages.at(-1)).toMatchObject({ type: "assistant", text: "settled" });
});

test("clean host restart resumes the saved session; a different generator gets its own", async () => {
  const first = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "remember this" }];
  await first.executor.run(request("first", messages));
  const id = first.runtime.sessions[0]!.options.sessionId;
  await first.host.close();
  expect(first.runtime.sessions[0]!.closed).toBe(true);
  const second = setup(first.directory);
  await second.executor.run(request("second", [...messages, { type: "user", text: "continue" }]));
  expect(second.runtime.sessions[0]!.options).toMatchObject({ sessionId: id, resume: true });
  expect(second.runtime.turns[0]).toContain("continue");
  expect(second.runtime.turns[0]).not.toContain("remember this");
  await second.executor.run({ ...request("other"), generatorId: "other" });
  expect(second.runtime.sessions[1]!.options.sessionId).not.toBe(id);
  expect(second.runtime.sessions[1]!.options.resume).toBe(false);
});

test("a process that died between activations reopens its saved conversation", async () => {
  const { executor, runtime } = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "remember this" }];
  await executor.run(request("first", messages));
  const id = runtime.sessions[0]!.options.sessionId;
  runtime.sessions[0]!.exited = true;
  messages.push({ type: "user", text: "continue" });
  expect((await executor.run(request("second", messages))).completionReason).toBe("done");
  expect(runtime.sessions).toHaveLength(2);
  expect(runtime.sessions[1]!.options).toMatchObject({ sessionId: id, resume: true });
  expect(runtime.sessions[1]!.turns[0]).toContain("continue");
  expect(runtime.sessions[1]!.turns[0]).not.toContain("remember this");
});

test("compaction mid-turn restores the current standing context without history", async () => {
  const { executor, runtime } = setup();
  let restored: string | undefined;
  runtime.onTurn = (session) => { restored = session.options.restore(); session.complete(); };
  const input = request("compacted", [{ type: "user", text: "an old event" }]);
  input.inference.recency = [{ type: "text", text: "State: deployed", slot: "state", volatile: true }];
  await executor.run(input);
  expect(restored).toContain("restored after this conversation was compacted");
  expect(restored).toContain("Tend this system.");
  expect(restored).toContain("State: deployed");
  expect(restored).not.toContain("an old event");
  expect(runtime.sessions[0]!.options.restore()).toBeUndefined(); // nothing is active between activations
});

test("a missing transcript starts a fresh conversation with the full context", async () => {
  const first = setup();
  const messages: FrameMessage[] = [{ type: "user", text: "remember this" }];
  await first.executor.run(request("first", messages));
  const id = first.runtime.sessions[0]!.options.sessionId;
  await first.host.close();
  const second = setup(first.directory);
  second.runtime.missing.add(id);
  expect((await second.executor.run(request("second", [...messages, { type: "user", text: "continue" }]))).completionReason).toBe("done");
  expect(second.runtime.sessions.map((s) => s.options.resume)).toEqual([true, false]);
  expect(second.runtime.sessions[0]!.closed).toBe(true);
  expect(second.runtime.sessions[1]!.turns[0]).toContain("remember this");
});

test("a terminal action interrupts the live Claude turn", async () => {
  const { executor, runtime } = setup();
  const input = request("terminal");
  input.inference.tools = [createAction({ state: null, name: "finish", inputSchema: z.object({}), run: () => actionResult({ value: "done", terminal: true }) })];
  runtime.onTurn = (session) => void session.call("finish", {});
  expect((await drive(executor, input)).completionReason).toBe("terminal-action");
  expect(runtime.sessions[0]!.interrupted).toBe(1);
  expect(runtime.turns).toHaveLength(1);
});

test("cancellation interrupts the native turn and an uncheckpointed session is not resumed", async () => {
  const first = setup();
  const abort = new AbortController();
  first.runtime.onTurn = () => abort.abort();
  expect((await first.executor.run({ ...request("cancelled"), signal: abort.signal })).completionReason).toBe("cancelled");
  expect(first.runtime.sessions[0]!.interrupted).toBe(1);
  const id = first.runtime.sessions[0]!.options.sessionId;
  await first.host.close();
  const second = setup(first.directory);
  await second.executor.run(request("next"));
  expect(second.runtime.sessions[0]!.options.resume).toBe(false);
  expect(second.runtime.sessions[0]!.options.sessionId).not.toBe(id);
});

test("native tool responses wait for Projector state commits without starting another Claude turn", async () => {
  const { executor, runtime } = setup();
  const count = createState({ key: "count", schema: z.number(), init: 0, projection: { render: (n) => `counter:${n}` } });
  const increment = createAction({ state: count, name: "increment", inputSchema: z.object({}), run(_args, context) {
    const next = context.state! + 1;
    context.updateState!({ op: "replace", value: next });
    return next;
  } });
  const node = createNode({ key: "counter", instructions: "Increment twice.", states: [count], parts: [tool(increment)], runtime: { type: "generator", trigger: { type: "actor-frame" } } });
  const charter = createCharter({ nodes: [node], actions: [increment], states: [count] });
  const machine = createMachine({ charter, executor, instance: createSourceInstance({ id: "counter", node }) });
  runtime.onTurn = (session) => void session.call("increment", {});
  runtime.onResponse = (session, reply) => {
    const n = runtime.responses.length;
    expect(reply.text).toContain(`counter:${n}`);
    if (n === 1) void session.call("increment", {});
    else session.complete();
  };
  machine.enqueueFrame({ messages: [{ type: "user", text: "Go" }] });
  for await (const _ of runMachine(machine)) void _;
  expect(machine.instance.states?.count?.value).toBe(2);
  expect(runtime.turns).toHaveLength(1);
  expect(runtime.sessions[0]!.interrupted).toBe(0);
});

test("parallel native tool calls run one Endograph action at a time", async () => {
  const { executor, runtime } = setup();
  const order: string[] = [];
  const echo = createAction({ state: null, name: "echo", inputSchema: z.object({ n: z.number() }), run: ({ n }) => { order.push(`run ${n}`); return n; } });
  const input = request("parallel");
  input.inference.tools = [echo];
  runtime.onTurn = (session) => {
    void Promise.all([session.call("echo", { n: 1 }), session.call("echo", { n: 2 })]).then(() => session.complete());
  };
  expect((await drive(executor, input)).completionReason).toBe("done");
  expect(order).toEqual(["run 1", "run 2"]);
  expect(runtime.responses.map((r) => r.success)).toEqual([true, true]);
});

test("different generators can park tool results and resume their own native turns", async () => {
  const { executor, runtime } = setup();
  const echo = createAction({ state: null, name: "echo", inputSchema: z.object({}), run: () => "echoed" });
  const first = request("one");
  first.inference.tools = [echo];
  const second = { ...request("two"), generatorId: "other" };
  second.inference.tools = [echo];
  runtime.onTurn = (session) => void session.call("echo", {});
  runtime.onResponse = (session) => session.complete();
  const one = await executor.run(first);
  const two = await executor.run(second);
  expect(one.completionReason).toBe("continue");
  expect(two.completionReason).toBe("continue");
  expect(runtime.responses).toHaveLength(0);
  expect((await executor.run({ ...first, activationId: "one-next", continuationState: one.continuationState })).completionReason).toBe("done");
  expect((await executor.run({ ...second, activationId: "two-next", continuationState: two.continuationState })).completionReason).toBe("done");
  expect(runtime.sessions).toHaveLength(2);
});

test("a changed output schema reopens the conversation with the new format", async () => {
  const { executor, runtime } = setup();
  await executor.run(request("plain"));
  const structured = request("structured");
  structured.output = { schema: z.object({ ok: z.boolean() }), mapTextBlock: (text: string) => JSON.parse(text) } as unknown as ExecutorRunRequest["output"];
  runtime.onTurn = (session) => session.complete({ text: '{"ok":true}' });
  await executor.run(structured);
  expect(runtime.sessions).toHaveLength(2);
  expect(runtime.sessions[0]!.closed).toBe(true);
  expect(runtime.sessions[1]!.options).toMatchObject({ resume: true, sessionId: runtime.sessions[0]!.options.sessionId });
  expect(runtime.sessions[1]!.options.outputSchema).toBeDefined();
});

test("the tool-call limit fails the activation and replaces the session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "endo-claude-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const host = new ClaudeHost({ stateDir: directory, runtime, maxToolCalls: 1, isActivationCommitted: () => true });
  cleanup.push(() => host.close());
  const executor = new NativeExecutor((input, emit, signal) => host.handle(input, signal ?? new AbortController().signal, emit ?? (() => {})), "claude");
  const input = request("limit");
  input.inference.tools = [createAction({ state: null, name: "echo", inputSchema: z.object({}), run: () => "echoed" })];
  runtime.onTurn = (session) => void session.options.call("list_actions", {}).then(() => session.options.call("list_actions", {}));
  await expect(executor.run(input)).rejects.toThrow("tool limit");
  expect(runtime.sessions[0]!.closed).toBe(true);
});
