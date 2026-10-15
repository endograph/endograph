import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgent } from "../src/harness/agent.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { PROTOCOL_VERSION, readReply, writeMessage, writeReply, type Delivered, type Reply, type RequestMessage } from "../src/protocol/wire.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { allFrames, type FrameInput } from "../src/store/types.ts";
import { answer, scripted } from "./fixtures/agent/scripted.ts";

const request = (id: string): Delivered<RequestMessage> => ({ v: PROTOCOL_VERSION, kind: "request", id, from: "local:original-sender", text: "who am i", at: 1 });
const reply = (id: string, state: Reply["state"] = "completed"): Reply => ({ v: PROTOCOL_VERSION, id, ok: true, state, text: `${state} ${id}`, at: 2 });
const replyFrame = (r: Reply): FrameInput => ({ type: "reply", id: r.id, summary: r.text, payload: r, at: r.at });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-mailbox-"));
  cpSync(join(import.meta.dir, "fixtures/agent"), dir, { recursive: true });
  mkdirSync(join(dir, ".endo/program"), { recursive: true });
  writeFileSync(join(dir, ".endo/scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', `"${import.meta.resolve("@projectors/core")}"`));
  rmSync(join(dir, "scripted.ts"));
  cpSync(join(import.meta.dir, "fixtures/program.ts"), join(dir, ".endo/program/agent.ts"));
  ensureStateDir(pathsOf(dir));
  return dir;
}

test("mailbox transactions roll back acceptance, delivery, replies, frames, and snapshots together", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-ledger-"));
  let store = openSqliteStore(join(dir, "agent.db"));
  try {
    const accepted = request("accepted");
    expect(store.acceptMessage(accepted)).toBe(true);
    expect(store.acceptMessage({ ...accepted, from: "local:impostor", text: "replacement" })).toBe(false);
    expect(() => store.transaction(() => {
      store.acceptMessage(request("rolled-back"));
      store.append({ type: "request", summary: "delivering", at: 1, payload: { metadata: { endo: { requests: [accepted] } } } });
      const terminal = reply(accepted.id);
      expect(store.commitReply(terminal, replyFrame(terminal))).toBe(true);
      store.writeSnapshot({ asOfSeq: store.lastSeq(), at: 3, state: { changed: true } });
      throw new Error("rollback all writes");
    })).toThrow("rollback all writes");
    store.close();
    store = openSqliteStore(join(dir, "agent.db"));
    expect(store.pendingMessages()).toEqual([accepted]);
    expect(store.readReply(accepted.id)).toBeNull();
    expect(store.replies()).toEqual([]);
    expect(store.readSnapshot()).toBeNull();
    expect([...allFrames(store)]).toEqual([]);
    expect(store.acceptMessage(request("rolled-back"))).toBe(true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reply and its frame commit atomically and a terminal reply cannot be replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-reply-"));
  let store = openSqliteStore(join(dir, "agent.db"));
  try {
    const working = reply("call", "working");
    expect(store.commitReply(working, replyFrame(working))).toBe(true);
    expect(store.commitReply(working, replyFrame(working))).toBe(false);
    const terminal = reply("call");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.commitReply(terminal, { ...replyFrame(terminal), payload: circular })).toThrow();
    expect(store.readReply("call")).toEqual(working);
    expect([...allFrames(store)]).toHaveLength(1);
    expect(store.commitReply(terminal, replyFrame(terminal))).toBe(true);
    store.close();
    store = openSqliteStore(join(dir, "agent.db"));
    for (const competing of [working, reply("call", "failed"), terminal]) {
      expect(store.commitReply(competing, replyFrame(competing))).toBe(false);
    }
    expect(store.readReply("call")).toEqual(terminal);
    expect(store.replies()).toEqual([terminal]);
    expect([...allFrames(store)].map((f) => f.payload)).toEqual([working, terminal]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart serves an accepted request after its inbox file was removed, preserving the stamped sender", async () => {
  const dir = fixture();
  const paths = pathsOf(dir);
  const accepted = request("accepted-before-crash");
  writeMessage(paths.inbox, accepted);
  try {
    const store = openSqliteStore(paths.db);
    store.acceptMessage(accepted);
    store.close();
    rmSync(join(paths.inbox, `${accepted.at}-${accepted.id}.json`));
    const agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    try {
      await agent.poll();
      expect(readReply(paths.outbox, accepted.id)).toMatchObject({ state: "completed", text: "seen from local:original-sender" });
      // Retrying the original wire ID must not re-execute its accepted request.
      writeMessage(paths.inbox, { ...accepted, text: "duplicate" });
      await agent.poll();
      expect([...allFrames(agent.store)].filter((f) => f.type === "request" && f.id === accepted.id)).toHaveLength(1);
      expect(readReply(paths.outbox, accepted.id)?.text).toBe("seen from local:original-sender");
    } finally {
      await agent.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart republishes committed replies when outbox files are missing or stale", async () => {
  const dir = fixture();
  const paths = pathsOf(dir);
  const canonical = [reply("missing"), reply("stale")];
  writeReply(paths.outbox, reply("stale", "working"));
  try {
    const store = openSqliteStore(paths.db);
    for (const r of canonical) store.commitReply(r, replyFrame(r));
    store.close();
    const agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    try {
      for (const expected of canonical) expect(readReply(paths.outbox, expected.id)).toEqual(expected);
      expect([...allFrames(agent.store)].filter((f) => f.type === "reply")).toHaveLength(2);
    } finally {
      await agent.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovering leftover run files cannot replace a committed terminal call reply", async () => {
  const dir = fixture();
  const paths = pathsOf(dir);
  const canonical = reply("settled-call");
  const store = openSqliteStore(paths.db);
  store.append({ type: "call", id: canonical.id, summary: "local:test: hello", payload: { procedure: "hello", args: {}, from: "local:test" }, at: 1 });
  store.commitReply(canonical, replyFrame(canonical));
  store.close();
  // A crash after committing the terminal result can leave any subset of
  // these files. The recovered exit would report a conflicting failure.
  writeFileSync(join(paths.runs, `${canonical.id}.json`), JSON.stringify({ id: canonical.id, procedure: "hello", file: join(paths.procedures, "hello.ts"), from: "local:test", args: {}, startedAt: 1, pid: 0 }));
  writeFileSync(join(paths.runs, `${canonical.id}.out`), "stale output");
  writeFileSync(join(paths.runs, `${canonical.id}.err`), "stale error");
  writeFileSync(join(paths.runs, `${canonical.id}.exit`), "1");
  writeReply(join(paths.runs, "acks"), reply(canonical.id, "working"));
  try {
    const agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    try {
      await Promise.all(agent.runs.active().map((run) => run.terminal));
      expect(readReply(paths.outbox, canonical.id)).toEqual(canonical);
      expect([...allFrames(agent.store)].filter((f) => f.type === "reply" && f.id === canonical.id).map((f) => f.payload)).toEqual([canonical]);
      expect(existsSync(join(paths.runs, `${canonical.id}.json`))).toBe(false);
    } finally {
      await agent.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
