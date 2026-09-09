import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeInstance } from "@projectors/core";
import { openAgent } from "../src/harness/agent.ts";
import { isLocked } from "../src/harness/lock.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { incept, inceptionStatus } from "../src/inception/incept.ts";
import { newId, readReply, writeMessage } from "../src/protocol/wire.ts";
import { archivePath, commitNumbers } from "../src/store/archive.ts";
import { snapshotAgent } from "../src/store/snapshot.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { allFrames } from "../src/store/types.ts";
import { answer, scripted } from "./fixtures/agent/scripted.ts";

const ROOT = resolve(import.meta.dir, "..");
function scaffold(dir: string): void {
  cpSync(join(ROOT, "test/fixtures/agent"), dir, { recursive: true });
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"));
  cpSync(join(ROOT, "test/fixtures/program.ts"), paths.program);
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
}

test("CLI snapshots a live agent and restores code, evolved state, history and replies without SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "endo-snapshot-"));
  const source = join(root, "source");
  const destination = join(root, "saved");
  scaffold(source);
  const paths = pathsOf(source);
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    await incept({ agentDir: source, inceptor: "true" });
    agent = await openAgent({ agentDir: source, executor: scripted(answer) });
    const ids: string[] = [];
    for (const text of ["note durable memory", "spawn a helper", "2+2?"]) {
      const id = newId();
      ids.push(id);
      writeMessage(paths.inbox, { v: 1, kind: "request", id, text, at: Date.now() });
      await agent.poll();
    }
    writeFileSync(join(paths.src, "agent-note.md"), "A file written after inception.");
    mkdirSync(join(paths.state, "home"));
    writeFileSync(join(paths.state, "home", "memory"), "Persistent HOME data.");
    writeFileSync(paths.env, "SNAPSHOT_SECRET=do-not-copy\n");
    const instance = serializeInstance(agent.loaded.machine.instance, agent.loaded.charter);
    const replies = ids.map((id) => readReply(paths.outbox, id));
    ticker = setInterval(() => agent!.store.append({ type: "test", at: Date.now(), summary: "source still running" }), 5);
    const child = Bun.spawn([process.execPath, "run", join(ROOT, "src/cli/index.ts"), "snapshot", destination], { cwd: source, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearInterval(ticker); ticker = undefined;
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("snapshot through archive commit");
    expect(isLocked(paths.lock)).toBe(true);
    const saved = pathsOf(destination);
    for (const file of [saved.db, `${saved.db}-wal`, saved.lock, saved.env, saved.modules, saved.outbox]) expect(existsSync(file)).toBe(false);
    expect(readFileSync(saved.program, "utf8")).toBe(readFileSync(paths.program, "utf8"));
    expect(readFileSync(join(saved.src, "agent-note.md"), "utf8")).toBe("A file written after inception.");
    expect(readFileSync(join(saved.state, "home", "memory"), "utf8")).toBe("Persistent HOME data.");
    const cutoff = commitNumbers(archivePath(saved.db)).at(-1)!;
    agent.store.append({ type: "test", at: Date.now(), summary: "after snapshot" });
    expect(commitNumbers(archivePath(paths.db)).at(-1)!).toBeGreaterThan(cutoff);
    await agent.stop(); agent = undefined;

    // Opening the saved directory recreates SQLite and the outbox, using only
    // copied files. The normal loader must not need another inception.
    expect((await inceptionStatus(saved)).n).toBe(1);
    agent = await openAgent({ agentDir: destination, executor: scripted(answer) });
    expect(serializeInstance(agent.loaded.machine.instance, agent.loaded.charter)).toEqual(instance);
    expect(ids.map((id) => readReply(saved.outbox, id))).toEqual(replies);
    const frames = [...allFrames(agent.store)];
    expect(JSON.stringify(frames)).toContain("durable memory");
    expect(frames.some((f) => f.summary === "after snapshot")).toBe(false);
    expect(frames.some((f) => f.summary === "source still running")).toBe(true);
    const next = newId();
    writeMessage(saved.inbox, { v: 1, kind: "request", id: next, text: "2+2?", at: Date.now() });
    await agent.poll();
    expect(readReply(saved.outbox, next)).toMatchObject({ ok: true, text: "4" });
  } finally {
    if (ticker) clearInterval(ticker);
    await agent?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("snapshot refuses existing destinations, unfinished or mismatched generations, and external symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "endo-snapshot-refuse-"));
  const source = join(root, "source");
  const destination = join(root, "saved");
  scaffold(source);
  const paths = pathsOf(source);
  try {
    await incept({ agentDir: source, inceptor: "true" });
    mkdirSync(destination);
    writeFileSync(join(destination, "keep"), "owner file");
    expect(() => snapshotAgent(source, destination)).toThrow("already exists");
    expect(readFileSync(join(destination, "keep"), "utf8")).toBe("owner file");
    rmSync(destination, { recursive: true });
    symlinkSync(join(root, "missing"), destination);
    expect(() => snapshotAgent(source, destination)).toThrow("already exists");
    expect(readlinkSync(destination)).toBe(join(root, "missing"));
    rmSync(destination);
    writeFileSync(join(paths.state, "promotion.json"), "{}");
    expect(() => snapshotAgent(source, destination)).toThrow("promotion is unfinished");
    expect(existsSync(destination)).toBe(false);
    rmSync(join(paths.state, "promotion.json"));
    const program = readFileSync(paths.program, "utf8");
    writeFileSync(paths.program, `${program}\n// edited outside inception\n`);
    expect(() => snapshotAgent(source, destination)).toThrow("program differs from the captured inception");
    expect(existsSync(destination)).toBe(false);
    writeFileSync(paths.program, program);
    symlinkSync(join(root, "outside"), join(paths.src, "external"));
    expect(() => snapshotAgent(source, destination)).toThrow("ordinary files");
    expect(existsSync(destination)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot discards its temporary copy when source files change during capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "endo-snapshot-changing-"));
  const source = join(root, "source");
  const destination = join(root, "saved");
  scaffold(source);
  const paths = pathsOf(source);
  const note = join(paths.src, "note.md");
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    await incept({ agentDir: source, inceptor: "true" });
    writeFileSync(note, "before");
    // Archive copying gives the parent time to change a file after the child's
    // initial hash and before its final check. No sleeps or production hooks.
    const store = openSqliteStore(paths.db);
    try {
      for (let i = 0; i < 100; i++) store.append({ type: "test", at: Date.now(), summary: String(i) });
    } finally { store.close(); }
    let edited = false;
    watcher = watch(root, (_event, name) => {
      if (!edited && name?.toString().startsWith(".saved-")) {
        writeFileSync(note, "changed during capture");
        edited = true;
      }
    });
    const child = Bun.spawn([process.execPath, "run", join(ROOT, "src/cli/index.ts"), "snapshot", destination], { cwd: source, stdout: "ignore", stderr: "pipe" });
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(edited).toBe(true);
    expect(code).toBe(1);
    expect(errors).toContain("agent files changed while copying");
    expect(existsSync(destination)).toBe(false);
  } finally {
    watcher?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
