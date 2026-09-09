import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgent } from "../src/harness/agent.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { isLocked } from "../src/harness/lock.ts";
import { readReply, writeMessage } from "../src/protocol/wire.ts";
import { scripted } from "./fixtures/agent/scripted.ts";
import { archivePath, StoreRecoveryRequired } from "../src/store/sqlite.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "endo-loop-"));
  cpSync(join(import.meta.dir, "fixtures/agent"), dir, { recursive: true });
  const paths = pathsOf(dir);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/program.ts"), paths.program);
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  return paths;
}

test("the serving loop applies backpressure and shutdown finishes only the current turn", async () => {
  const paths = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => enter = resolve);
  const hold = new Promise<void>((resolve) => release = resolve);
  const served: string[] = [];
  const agent = await openAgent({ agentDir: paths.agentDir, pollMs: 5, executor: scripted(async ({ requests, call }) => {
    enter();
    await hold;
    for (const request of requests) {
      served.push(request.id);
      await call("reply", { id: request.id, ok: true, text: "finished" });
    }
  }) });
  let polls = 0;
  const poll = agent.poll;
  agent.poll = () => { polls++; return poll(); };
  const send = (id: string) => writeMessage(paths.inbox, { v: 1, kind: "request", id, text: id, at: Date.now() });
  try {
    send("first");
    agent.start();
    await entered;
    send("later");
    await Bun.sleep(80);
    expect(polls).toBe(1);
    // Even explicit work queued before stop must not start after retirement.
    const queued = poll();
    const stopped = agent.stop();
    expect(agent.stop()).toBe(stopped);
    expect(isLocked(paths.lock)).toBe(true);
    release();
    await stopped;
    await queued;
    expect(served).toEqual(["first"]);
    expect(readReply(paths.outbox, "first")?.text).toBe("finished");
    expect(readReply(paths.outbox, "later")).toBeNull();
    expect(isLocked(paths.lock)).toBe(false);
    expect(agent.status().running).toBe(false);
    const count = polls;
    agent.start();
    await Bun.sleep(20);
    expect(polls).toBe(count);
  } finally { release(); await agent.stop(); rmSync(paths.agentDir, { recursive: true, force: true }); }
});

test("shutdown wakes an idle loop without waiting for its poll delay", async () => {
  const paths = fixture();
  const agent = await openAgent({ agentDir: paths.agentDir, pollMs: 60_000, executor: scripted(async () => {}) });
  try {
    agent.start();
    await agent.poll();
    expect(await Promise.race([agent.stop().then(() => "stopped"), Bun.sleep(500).then(() => "timeout")])).toBe("stopped");
    expect(isLocked(paths.lock)).toBe(false);
  } finally { await agent.stop(); rmSync(paths.agentDir, { recursive: true, force: true }); }
});

test("a persistence failure interrupts a graceful shutdown already waiting on active work", async () => {
  const paths = fixture();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  let failures = 0;
  const agent = await openAgent({ agentDir: paths.agentDir, onFailure: () => { failures++; }, executor: scripted(async () => {
    entered.resolve();
    await held.promise;
  }) });
  try {
    writeMessage(paths.inbox, { v: 1, kind: "request", id: "blocked", text: "wait", at: Date.now() });
    agent.start();
    await entered.promise;
    const stopped = agent.stop();
    const archive = archivePath(paths.db);
    renameSync(archive, `${archive}-saved`);
    writeFileSync(archive, "blocks publication");
    expect(() => agent.store.append({ type: "test", summary: "cannot persist", at: Date.now() })).toThrow(StoreRecoveryRequired);
    expect(await Promise.race([stopped.then(() => "stopped"), Bun.sleep(1000).then(() => "timeout")])).toBe("stopped");
    expect(isLocked(paths.lock)).toBe(false);
    await Bun.sleep(10);
    expect(failures).toBe(1);
  } finally { held.resolve(); await agent.stop(); rmSync(paths.agentDir, { recursive: true, force: true }); }
});
