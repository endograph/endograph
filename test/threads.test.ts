import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { threadStore } from "../src/store/threads.ts";
import { agentQuery } from "../src/client.ts";
import { PROTOCOL_VERSION as v } from "../src/protocol/wire.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "endo-threads-"));
  mkdirSync(join(dir, ".endo"));
  writeFileSync(join(dir, "endograph.toml"), 'name="fixture"\n');
  return { dir, db: join(dir, ".endo/agent.db"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}
test("threads, queued requests, replies and metadata survive archive-only recovery", () => {
  const f = fixture();
  try {
    let store = openSqliteStore(f.db), threads = threadStore(store);
    const empty = threads.create({ id: "empty", title: "No messages" });
    threads.create({ id: "discussion", title: "Production", metadata: { incident: "X" } });
    threads.update("discussion", { title: "Auth", archived: true, metadata: { severity: 2 } });
    const message = { v: v as typeof v, kind: "request" as const, id: "r1", thread: "discussion", from: "client:test", text: "hello", at: 1 };
    threads.send(message); threads.send(message);
    expect(store.pendingMessages()).toHaveLength(1);
    store.append({ type: "request", at: 2, summary: "delivered", payload: { metadata: { endo: { requests: [message] } } } });
    const reply = { v: v as typeof v, id: "r1", ok: true, state: "completed" as const, text: "hi", at: 3 };
    store.commitReply(reply, { type: "reply", id: "r1", at: 3, summary: "hi", payload: reply });
    threads.send({ ...message, id: "pending" });
    const before = threads.messages({ threadId: "discussion" });
    const end = store.lastSeq();
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(f.db + suffix, { force: true });
    store = openSqliteStore(f.db); threads = threadStore(store);
    expect(threads.get("empty")).toEqual(empty);
    expect(threads.get("discussion")).toMatchObject({ title: "Auth", archived: true, metadata: { incident: "X", severity: 2 } });
    expect(threads.messages({ threadId: "discussion" })).toEqual(before);
    expect(store.pendingMessages().map(m => m.id)).toEqual(["pending"]);
    expect(store.lastSeq()).toBe(end);
    expect(threads.messages().messages.filter(m => m.id === "r1" && m.kind === "request")).toHaveLength(1);
    store.close();
  } finally { f.remove(); }
});
test("explicit threads and multi-message frame pagination preserve all messages", () => {
  const f = fixture();
  try {
    const store = openSqliteStore(f.db), threads = threadStore(store);
    const id = crypto.randomUUID();
    for (let n = 0; n < 3; n++) store.append({ type: "request", at: n, summary: "batch", payload: { metadata: { endo: { requests: [0, 1].map(i => ({ v, kind: "request", id: `r${n}-${i}`, from: "client:test", thread: id, text: `${n}-${i}`, at: n })) } } } });
    expect(threads.list().map(t => t.id)).toEqual([id]);
    expect(threads.get(id)?.title).toBe("Untitled");
    const page = threads.messages({ threadId: id, limit: 1 });
    expect(page.messages.map(m => m.text)).toEqual(["2-0", "2-1"]);
    expect(threads.messages({ threadId: id, limit: 1, before: page.nextBefore! }).messages.map(m => m.text)).toEqual(["1-0", "1-1"]);
    store.close();
  } finally { f.remove(); }
});
test("refs remain opaque and never assign messages to threads", () => {
  const f = fixture();
  const store = openSqliteStore(f.db), threads = threadStore(store);
  try {
    threads.create({ id: "discussion", title: "Explicit title" });
    const requests = ["discussion", "app-web:discussion", "thread:discussion"].map((ref, i) => ({
      v, kind: "request", id: `ref-${i}`, from: "client:test", ref, text: "Message title", at: 1,
    }));
    store.append({ type: "request", at: 1, summary: "refs", payload: { metadata: { endo: { requests } } } });
    expect(threads.list().map(t => t.id)).toEqual(["discussion"]);
    expect(threads.messages({ threadId: "discussion" }).messages).toEqual([]);
    expect(threads.messages().messages).toHaveLength(3);
    expect(threads.messages().messages.every(m => m.threadId === undefined)).toBe(true);
    expect(threads.get("discussion")?.title).toBe("Explicit title");
  } finally { store.close(); f.remove(); }
});
test("client API is literal, idempotent, paginated, and does not import generated code", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, ".endo/program"));
    writeFileSync(join(f.dir, ".endo/program/agent.ts"), 'throw new Error("must not load");');
    await agentQuery(f.dir, { op: "threads.create", id: "one", title: "Example" });
    for (const text of ["--agent", "$(touch escaped); `whoami`", "hello\nworld"]) {
      const id = crypto.randomUUID();
      const request = { op: "messages.send", id, threadId: "one", text };
      await agentQuery(f.dir, request); await agentQuery(f.dir, request);
      await expect(agentQuery(f.dir, { ...request, text: "different" })).rejects.toThrow("already used");
    }
    const history: any = await agentQuery(f.dir, { op: "messages.list", threadId: "one" });
    expect(history.messages).toHaveLength(3);
    expect(history.messages[0].text).toBe("--agent");
    const page: any = await agentQuery(f.dir, { op: "frames.list", query: "queued", limit: 2 });
    expect(page.frames).toHaveLength(2); expect(page.total).toBe(3); expect(page.nextBefore).toBeNumber();
    const detail: any = await agentQuery(f.dir, { op: "frames.get", seq: page.frames[0].seq });
    expect(detail.payload.thread).toBe("one");
    for (const bad of [{ op: "threads.create", id: "../../.env" }, { op: "messages.list", before: -1 }, { op: "frames.list", limit: 9999 }, { op: "messages.send", id: "x", threadId: "one", text: " " }, { op: "sql", sql: "select 1" }]) await expect(agentQuery(f.dir, bad)).rejects.toThrow();
  } finally { f.remove(); }
});
test("independent clients serialize thread creation and messages without duplicate IDs", async () => {
  const f = fixture();
  try {
    // A pre-segment database can be opened by several clients during upgrade.
    const old = new Database(f.db, { create: true });
    old.exec("CREATE TABLE archive_state (id INTEGER PRIMARY KEY, commit_no INTEGER NOT NULL); INSERT INTO archive_state VALUES (1,0)");
    old.close();
    const payload = JSON.stringify({ op: "threads.create", id: "shared", title: "Shared" });
    const jobs = Array.from({ length: 4 }, () => {
      const p = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../src/cli/index.ts"), "api"], { cwd: f.dir, stdin: new TextEncoder().encode(payload), stdout: "pipe", stderr: "pipe" });
      return Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    });
    for (const [code, out, err] of await Promise.all(jobs)) { expect(code, String(err)).toBe(0); expect(JSON.parse(String(out)).id).toBe("shared"); }
    expect((await agentQuery(f.dir, { op: "threads.list" }) as any).threads).toHaveLength(1);
    expect((await agentQuery(f.dir, { op: "frames.list" }) as any).total).toBe(1);
  } finally { f.remove(); }
});
