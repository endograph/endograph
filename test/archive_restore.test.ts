import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeInstance, type SerializedInstance } from "@projectors/core";
import { openAgent } from "../src/harness/agent.ts";
import { isLocked } from "../src/harness/lock.ts";
import { ensureStateDir, pathsOf, type Paths } from "../src/harness/paths.ts";
import { incept, inceptionStatus } from "../src/inception/incept.ts";
import { newId, readReply, waitForReply, writeMessage, type Reply } from "../src/protocol/wire.ts";
import { allFrames, type Frame } from "../src/store/types.ts";
import { archivePath, StoreRecoveryRequired } from "../src/store/sqlite.ts";
import { answer, scripted } from "./fixtures/agent/scripted.ts";

const ROOT = resolve(import.meta.dir, "..");
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-"));
  cpSync(join(ROOT, "test/fixtures/agent"), dir, { recursive: true });
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/program.ts"), paths.program);
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  return dir;
}
function removeDatabase(paths: Paths): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.db}${suffix}`, { force: true });
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for harness state");
}

test("a harness restores inception, evolved instance, full history and canonical replies without SQLite", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  try {
    await incept({ agentDir: dir, inceptor: "true" });
    expect(existsSync(join(paths.snapshots, "1/instance.json"))).toBe(true);
    removeDatabase(paths);
    expect((await inceptionStatus(paths)).n).toBe(1);
    let agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    const ids: string[] = [];
    let instance: SerializedInstance;
    let frames: Frame[];
    let replies: (Reply | null)[];
    try {
      for (const text of ["note remember this", "spawn a helper", "2+2?"]) {
        const id = newId();
        ids.push(id);
        writeMessage(paths.inbox, { v: 1, kind: "request", id, text, at: Date.now() });
        await agent.poll();
      }
      instance = serializeInstance(agent.loaded.machine.instance, agent.loaded.charter);
      expect(agent.loaded.machine.instance.children?.map((c) => c.node.key)).toEqual(["helper"]);
      frames = [...allFrames(agent.store)];
      replies = ids.map((id) => readReply(paths.outbox, id));
    } finally { await agent.stop(); }
    removeDatabase(paths);
    for (const id of ids) rmSync(join(paths.outbox, `${id}.json`));
    agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    try {
      expect(ids.map((id) => readReply(paths.outbox, id))).toEqual(replies);
      expect(serializeInstance(agent.loaded.machine.instance, agent.loaded.charter)).toEqual(instance);
      expect([...allFrames(agent.store)]).toEqual(frames);
    } finally { await agent.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an async acknowledgement archive failure stops the old harness and leaves its run recoverable", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const ack = join(paths.state, "allow-ack");
  const finish = join(paths.state, "allow-finish");
  writeFileSync(join(paths.procedures, "wait.ts"), `
import { existsSync } from "node:fs";
import { procedure, actionResult } from "endograph/procedure";
await procedure({ description: "wait", expose: true });
while (!existsSync(${JSON.stringify(ack)})) await Bun.sleep(10);
actionResult("waiting");
while (!existsSync(${JSON.stringify(finish)})) await Bun.sleep(10);
console.log("finished");
`);
  let failure: Error | undefined;
  let agent = await openAgent({ agentDir: dir, executor: scripted(answer), onFailure: (error) => { failure = error; } });
  const archive = archivePath(paths.db);
  const saved = `${archive}-saved`;
  try {
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "call", id, procedure: "wait", args: {}, at: Date.now() });
    await agent.poll();
    renameSync(archive, saved);
    writeFileSync(archive, "blocks archive publication");
    writeFileSync(ack, "");
    await until(() => !!failure);
    expect(failure).toBeInstanceOf(StoreRecoveryRequired);
    expect(isLocked(paths.lock)).toBe(false);
    expect(agent.status().running).toBe(false);
    expect(readReply(paths.outbox, id)).toBeNull();
    expect(existsSync(join(paths.runs, `${id}.json`))).toBe(true);
    await expect(agent.poll()).rejects.toBeInstanceOf(StoreRecoveryRequired);
    rmSync(archive);
    renameSync(saved, archive);
    agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    expect(await waitForReply(paths.outbox, id, { timeoutMs: 3000, pollMs: 25 })).toMatchObject({ state: "working", text: "waiting" });
    const run = agent.runs.get(id)!;
    writeFileSync(finish, "");
    expect(await run.terminal).toMatchObject({ state: "completed", text: "finished" });
  } finally {
    writeFileSync(ack, "");
    writeFileSync(finish, "");
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
