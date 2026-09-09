import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeInstance, type ExecutorRunRequest, type ProjectorExecutor } from "@projectors/core";
import { loadGrant } from "../src/grant/grant.ts";
import { bindRuntime } from "../src/grant/bind.ts";
import { openAgent, type Agent } from "../src/harness/agent.ts";
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
