import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openAgent, type Agent } from "../src/harness/agent.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { newId, PROTOCOL_VERSION, readReply, writeMessage } from "../src/protocol/wire.ts";
import { StoreRecoveryRequired, type AgentStore } from "../src/store/sqlite.ts";
import { allFrames } from "../src/store/types.ts";
import { scripted } from "./fixtures/agent/scripted.ts";

const ROOT = resolve(import.meta.dir, "..");
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-delivery-"));
  cpSync(join(ROOT, "test/fixtures/agent"), dir, { recursive: true });
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/program.ts"), paths.program);
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  return dir;
}
function send(agent: Agent): string {
  const id = newId();
  writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text: "answer once", at: Date.now() });
  return id;
}

test("a rolled-back delivery stops the worker and a fresh open delivers it once", async () => {
  const dir = scaffold();
  let executions = 0;
  const executor = scripted(async (turn) => {
    for (const request of turn.requests) {
      executions++;
      await turn.call("reply", { id: request.id, ok: true, text: "answered" });
    }
  });
  let failed!: (error: Error) => void;
  const stopped = new Promise<Error>((resolve) => { failed = resolve; });
  let agent = await openAgent({ agentDir: dir, executor, onFailure: failed });
  try {
    const id = send(agent);
    const oldMachine = agent.loaded.machine;
    const store = agent.store as AgentStore;
    const append = store.append;
    store.append = (frame) => {
      const stored = append(frame);
      if (frame.type === "request") throw new Error("delivery commit failed");
      return stored;
    };
    await expect(agent.poll()).rejects.toThrow("delivery commit failed");
    expect(await stopped).toBeInstanceOf(StoreRecoveryRequired);
    expect(executions).toBe(0);
    expect(agent.status()).toMatchObject({ running: false, open: [] });
    await expect(agent.tick()).rejects.toThrow(StoreRecoveryRequired);
    await expect(agent.reload()).rejects.toThrow(StoreRecoveryRequired);
    await expect(agent.poll()).rejects.toThrow(StoreRecoveryRequired);
    expect(agent.loaded.machine).toBe(oldMachine);

    agent = await openAgent({ agentDir: dir, executor });
    const recovered = agent.store as AgentStore;
    expect(recovered.pendingMessages().map((m) => m.id)).toEqual([id]);
    expect([...allFrames(recovered)].filter((f) => f.type === "request")).toHaveLength(0);
    expect(agent.loaded.machine).not.toBe(oldMachine);
    await agent.poll();
    expect(executions).toBe(1);
    expect(readReply(agent.paths.outbox, id)).toMatchObject({ state: "completed", text: "answered" });
    expect([...allFrames(recovered)].filter((f) => f.type === "request")).toHaveLength(1);
    expect(recovered.pendingMessages()).toEqual([]);
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop cleans up after a failed delivery without snapshotting uncommitted work", async () => {
  const dir = scaffold();
  let executions = 0;
  const executor = scripted(async (turn) => {
    for (const request of turn.requests) {
      executions++;
      await turn.call("reply", { id: request.id, ok: true, text: "answered" });
    }
  });
  let agent = await openAgent({ agentDir: dir, executor });
  try {
    const id = send(agent);
    const store = agent.store as AgentStore;
    const append = store.append;
    store.append = (frame) => {
      if (frame.type === "request") throw new Error("delivery failed");
      return append(frame);
    };
    await expect(agent.poll()).rejects.toThrow("delivery failed");
    await agent.stop();
    agent = await openAgent({ agentDir: dir, executor });
    expect(agent.store.readSnapshot()).toBeNull();
    await agent.poll();
    expect(executions).toBe(1);
    expect(readReply(agent.paths.outbox, id)).toMatchObject({ state: "completed", text: "answered" });
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing log observer cannot interrupt request commits or reply publication", async () => {
  const dir = scaffold();
  let logs = 0;
  const agent = await openAgent({ agentDir: dir, log: () => { logs++; throw new Error("logger failed"); }, executor: scripted(async (turn) => {
    for (const request of turn.requests) await turn.call("reply", { id: request.id, ok: true, text: "answered" });
  }) });
  try {
    const id = send(agent);
    await agent.poll();
    expect(logs).toBeGreaterThan(0);
    expect(readReply(agent.paths.outbox, id)).toMatchObject({ state: "completed", text: "answered" });
    const store = agent.store as AgentStore;
    expect(store.readReply(id)).toEqual(readReply(agent.paths.outbox, id));
    expect(store.pendingMessages()).toEqual([]);
    expect(agent.status().open).toEqual([]);
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
