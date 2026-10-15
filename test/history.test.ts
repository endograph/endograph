import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeInstance, type ExecutorRunRequest, type ProjectorExecutor } from "@projectors/core";
import { loadGrant } from "../src/grant/grant.ts";
import { bindRuntime } from "../src/grant/bind.ts";
import { openAgent, OVERFLOW, type Agent } from "../src/harness/agent.ts";
import { loadAgent } from "../src/program/load.ts";
import { newId, PROTOCOL_VERSION, readReply, writeMessage } from "../src/protocol/wire.ts";
import { scripted } from "./fixtures/agent/scripted.ts";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-history-"));
  cpSync(join(import.meta.dir, "fixtures/agent"), dir, { recursive: true });
  mkdirSync(join(dir, ".endo/program"), { recursive: true });
  writeFileSync(join(dir, ".endo/scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', `"${import.meta.resolve("@projectors/core")}"`));
  rmSync(join(dir, "scripted.ts"));
  cpSync(join(import.meta.dir, "fixtures/program.ts"), join(dir, ".endo/program/agent.ts"));
  return dir;
}

function executor(histories: ExecutorRunRequest["inference"]["history"][]): ProjectorExecutor {
  const delegate = scripted(async ({ requests, call }) => {
    for (const request of requests) {
      if (request.text === "compact now") {
        expect((await call("compact", { summary: "The earlier request has been settled." })).success).toBe(true);
      } else if (request.text === "remember this") {
        expect((await call("update_state", { state: "notes", op: "append", path: ["lines"], values: ["once"] })).success).toBe(true);
      } else if (request.text === "still working marker") {
        await call("reply", { id: request.id, ok: true, state: "working", text: "on it" });
        continue;
      }
      await call("reply", { id: request.id, ok: true, text: "done" });
    }
  });
  return {
    ...delegate,
    async run(request) {
      histories.push(structuredClone(request.inference.history));
      return delegate.run(request);
    },
  };
}

async function send(agent: Agent, text: string): Promise<void> {
  const id = newId();
  writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text, at: Date.now() });
  await agent.poll();
  expect(readReply(agent.paths.outbox, id)).toMatchObject({ ok: true, state: "completed" });
}

test("procedure reload and restart preserve the history delivered to the executor without repeating state writes", async () => {
  const dir = fixture();
  const histories: ExecutorRunRequest["inference"]["history"][] = [];
  const runtime = executor(histories);
  let agent = await openAgent({ agentDir: dir, executor: runtime });
  try {
    await send(agent, "remember this");
    const previousFrames = structuredClone(agent.loaded.machine.frames);
    expect(agent.loaded.machine.instance.states?.notes?.value).toEqual({ lines: ["once"] });

    cpSync(join(import.meta.dir, "fixtures/procedures/hello.ts"), join(agent.paths.procedures, "hello.ts"));
    await agent.reload();
    expect(agent.loaded.procedures.map((p) => p.name)).toContain("hello");
    expect(agent.loaded.machine.frames).toEqual(previousFrames);
    expect(agent.loaded.machine.instance.states?.notes?.value).toEqual({ lines: ["once"] });
    await send(agent, "after reload");
    expect(JSON.stringify(histories.at(-1))).toContain("remember this");

    await agent.stop();
    agent = await openAgent({ agentDir: dir, executor: runtime });
    expect(agent.loaded.machine.instance.states?.notes?.value).toEqual({ lines: ["once"] });
    await send(agent, "after restart");
    expect(JSON.stringify(histories.at(-1))).toContain("remember this");
    expect(JSON.stringify(histories.at(-1))).toContain("after reload");
    expect(histories).toHaveLength(3); // Historical work must not run again.
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction keeps its summary and horizon across reload and restart while preserving older log frames", async () => {
  const dir = fixture();
  const histories: ExecutorRunRequest["inference"]["history"][] = [];
  const runtime = executor(histories);
  let agent = await openAgent({ agentDir: dir, executor: runtime });
  try {
    await send(agent, "obsolete conversation marker");
    await send(agent, "compact now");
    await agent.reload();
    await send(agent, "after compaction reload");
    const afterReload = JSON.stringify(histories.at(-1));
    expect(afterReload).toContain("The earlier request has been settled.");
    expect(afterReload).not.toContain("obsolete conversation marker");
    expect(JSON.stringify(agent.loaded.machine.frames)).toContain("obsolete conversation marker");

    await agent.stop();
    agent = await openAgent({ agentDir: dir, executor: runtime });
    await send(agent, "after compaction restart");
    const afterRestart = JSON.stringify(histories.at(-1));
    expect(afterRestart).toContain("The earlier request has been settled.");
    expect(afterRestart).toContain("after compaction reload");
    expect(afterRestart).not.toContain("obsolete conversation marker");
    expect(JSON.stringify(agent.loaded.machine.frames)).toContain("obsolete conversation marker");
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loading an inception's migrated instance restores history but applies only post-snapshot mutations", async () => {
  const dir = fixture();
  const agent = await openAgent({ agentDir: dir, executor: executor([]) });
  try {
    await send(agent, "remember this");
    const migrated = serializeInstance(agent.loaded.machine.instance, agent.loaded.charter);
    migrated.states!.notes = { value: { lines: ["migrated"] } };
    // The snapshot includes the earlier append of 'once', but not this tail.
    agent.loaded.machine.enqueueFrame({
      messages: [{ type: "instance", kind: "state.update", instanceId: "agent", stateKey: "notes", update: { op: "append", path: ["lines"], values: ["tail"] } }],
    });
    const expectedHistory = structuredClone(agent.loaded.machine.frames);
    const grant = await loadGrant(agent.paths);
    const loaded = await loadAgent({
      paths: agent.paths,
      grant,
      bindings: await bindRuntime(agent.paths, grant),
      store: agent.store,
      actions: Object.values(agent.loaded.provisions.actions),
      cwd: dir,
      startRun: () => { throw new Error("dry load cannot start a procedure"); },
      instance: migrated,
    });
    expect(loaded.machine.instance.states?.notes?.value).toEqual({ lines: ["migrated", "tail"] });
    expect(loaded.machine.frames).toEqual(expectedHistory);
    expect(loaded.replayedTo).toBe(agent.store.lastSeq());
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const horizons = (agent: Agent) => agent.loaded.machine.frames.filter((f) => f.messages.some((m) => m.type === "horizon"));
const noticed = (agent: Agent) => agent.loaded.machine.frames.some((f) => f.messages.some((m) => m.type === "user" && (m.actor as { id?: string } | undefined)?.id === "endo"));

test("history past its limits carries a compaction notice, then the harness compacts it before the next request", async () => {
  const dir = fixture();
  const histories: ExecutorRunRequest["inference"]["history"][] = [];
  const agent = await openAgent({ agentDir: dir, executor: executor(histories), history: { noticeBytes: 1500, compactBytes: 6000 } });
  try {
    await send(agent, "remember this");
    const working = newId();
    writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id: working, text: "still working marker", at: Date.now() });
    await agent.poll();
    expect(readReply(agent.paths.outbox, working)).toMatchObject({ state: "working" });
    await send(agent, "earliest marker");
    for (let i = 0; JSON.stringify(histories.at(-1)).includes("earliest marker"); i++) {
      expect(i).toBeLessThan(40);
      await send(agent, `filler ${i}`);
    }
    expect(noticed(agent)).toBe(true);
    expect(horizons(agent).length).toBeGreaterThan(0); // recent summaries can carry the marker past a first compaction
    const after = JSON.stringify(histories.at(-1));
    expect(after).toContain(`id=${working}`); // still owed a reply, so carried past the horizon
    expect(after).not.toContain("earliest marker");
    expect(agent.loaded.machine.instance.states?.notes?.value).toEqual({ lines: ["once"] });
    expect(JSON.stringify(agent.loaded.machine.frames)).toContain("earliest marker");
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an activation whose history overflows is compacted and delivered once more", async () => {
  const dir = fixture();
  const histories: ExecutorRunRequest["inference"]["history"][] = [];
  const delegate = executor(histories);
  let refused = 0;
  const runtime: ProjectorExecutor = {
    ...delegate,
    async run(request) {
      if (JSON.stringify(request.inference.history).includes("oversized marker")) { refused++; throw new Error("host request too large"); }
      return delegate.run(request);
    },
  };
  const agent = await openAgent({ agentDir: dir, executor: runtime });
  try {
    const id = newId();
    writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text: "an oversized request\noversized marker", at: Date.now() });
    await agent.poll();
    expect(readReply(agent.paths.outbox, id)).toMatchObject({ ok: false, state: "failed" }); // the request itself is too large
    expect(refused).toBe(2);
    await send(agent, "after the overflow");
    expect(refused).toBe(2);
    expect(horizons(agent).length).toBeGreaterThan(0);
    expect(JSON.stringify(histories.at(-1))).not.toContain("oversized marker");
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an activation that overflows after acting is delivered once more with the actions it started", async () => {
  const dir = fixture();
  const histories: ExecutorRunRequest["inference"]["history"][] = [];
  let runs = 0;
  const acting = scripted(async ({ call }) => {
    expect((await call("update_state", { state: "notes", op: "append", path: ["lines"], values: ["once"] })).success).toBe(true);
    throw new Error("host request too large");
  });
  const delegate = executor(histories);
  const runtime: ProjectorExecutor = { ...delegate, run: (request) => (runs++ === 0 ? acting : delegate).run(request) };
  const agent = await openAgent({ agentDir: dir, executor: runtime });
  try {
    const id = newId();
    writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text: "act then overflow", at: Date.now() });
    await agent.poll();
    expect(runs).toBe(2);
    expect(readReply(agent.paths.outbox, id)).toMatchObject({ ok: true, state: "completed" });
    expect(horizons(agent)).toHaveLength(1);
    expect(JSON.stringify(histories.at(-1))).toContain("update_state");
    expect(agent.loaded.machine.instance.states?.notes?.value).toBeUndefined(); // the failed attempt recorded nothing
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  "host request too large",
  "context_length_exceeded",
  "This model's maximum context length is 200000 tokens",
  "prompt is too long: 210000 tokens > 200000 maximum",
  "input exceeds the context window",
])("%s is a context overflow", (error) => expect(OVERFLOW.test(error)).toBe(true));

test.each([
  "context canceled",
  "context deadline exceeded",
  "TypeError: undefined is not an object (evaluating 'Context.x')",
  "host result too large",
  "model chunk too large",
  "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens",
])("%s is not a context overflow", (error) => expect(OVERFLOW.test(error)).toBe(false));
