import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePath, openSqliteStore, StoreRecoveryRequired } from "../src/store/sqlite.ts";
import { allFrames } from "../src/store/types.ts";
import { PROTOCOL_VERSION, type CallMessage, type Delivered, type Reply, type RequestMessage } from "../src/protocol/wire.ts";

const request: Delivered<RequestMessage> = { v: PROTOCOL_VERSION, kind: "request", id: "request", text: "remember", from: "local:owner", at: 1 };
const terminal: Reply = { v: PROTOCOL_VERSION, id: "request", ok: true, state: "completed", text: "remembered", at: 3 };
const replies = (store: ReturnType<typeof openSqliteStore>, reply = terminal) => store.commitReply(reply, { type: "reply", id: reply.id, summary: reply.text, payload: reply, at: reply.at });
const note = (summary: string) => ({ type: "note", summary, at: 1 });

test("a copy of immutable commits rebuilds history, checkpoint, sender/dedup and canonical replies without a live database", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-"));
  const source = join(dir, "source");
  const copy = join(dir, "copy");
  mkdirSync(source);
  mkdirSync(copy);
  const store = openSqliteStore(join(source, "agent.db"));
  try {
    store.acceptMessage(request);
    store.append({ type: "request", id: request.id, summary: request.text, at: 1, payload: {
      id: "request-frame", messages: [{ type: "user", text: request.text, actor: { id: request.from, label: request.from } }],
      metadata: { endo: { requests: [request] } },
    } });
    // Internal calls never passed through inbox acceptance. Their frames
    // must still prevent replaying the same ID through the wire.
    const call: Delivered<CallMessage> = { v: PROTOCOL_VERSION, kind: "call", id: "internal-call", procedure: "hello", args: {}, from: "agent:fixture", at: 1 };
    store.append({ type: "call", id: call.id, summary: "hello", at: call.at, payload: { procedure: call.procedure, args: call.args, from: call.from } });
    expect(store.pendingMessages()).toEqual([]);
    expect(store.acceptMessage(call)).toBe(false);
    expect(store.acceptMessage({ ...request, from: "local:impostor" })).toBe(false);
    store.transaction(() => {
      store.append({ type: "inception", summary: "inception 1", at: 2, payload: { n: 1, promotion: "matching-code" } });
      store.writeSnapshot({ asOfSeq: store.lastSeq(), at: 2, state: { id: "agent", memory: "migrated" } });
    });
    replies(store);
    const history = [...allFrames(store)];
    const checkpoint = store.readSnapshot();
    store.acceptMessage({ ...request, id: "still-pending" });
    // Copy while the source database remains open and has uncheckpointed WAL.
    cpSync(archivePath(join(source, "agent.db")), archivePath(join(copy, "agent.db")), { recursive: true });
    store.append(note("after the copied prefix"));

    const restored = openSqliteStore(join(copy, "agent.db"));
    try {
      expect([...allFrames(restored)]).toEqual(history);
      expect(restored.readSnapshot()).toEqual(checkpoint);
      expect(restored.readReply(request.id)).toEqual(terminal);
      expect(restored.acceptMessage({ ...request, from: "local:impostor" })).toBe(false);
      expect(restored.acceptMessage(call)).toBe(false);
      expect(restored.pendingMessages()).toEqual([]);
      expect(replies(restored, { ...terminal, state: "failed" })).toBe(false);
      expect(restored.append(note("continued on restored host")).seq).toBe(5);
    } finally { restored.close(); }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inception frame and checkpoint share one immutable decision; nested rollback publishes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-batch-"));
  const path = join(dir, "agent.db");
  const store = openSqliteStore(path);
  try {
    store.transaction(() => {
      store.append(note("first"));
      expect(() => store.transaction(() => {
        store.append(note("rolled back"));
        store.writeSnapshot({ asOfSeq: 2, at: 2, state: { wrong: true } });
        throw new Error("abandon candidate");
      })).toThrow("abandon candidate");
      store.append({ type: "inception", summary: "new code", payload: { promotion: "token" }, at: 3 });
      store.writeSnapshot({ asOfSeq: 2, at: 3, state: { right: true } });
    });
    const names = readdirSync(archivePath(path)).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const commit = JSON.parse(readFileSync(join(archivePath(path), names[0]!), "utf8"));
    expect(commit.frames.map((frame: { summary: string }) => frame.summary)).toEqual(["first", "new code"]);
    expect(commit.snapshot).toEqual({ asOfSeq: 2, at: 3, state: { right: true } });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("archive publication survives failed SQLite commit and poisons the connection until recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-commit-"));
  const path = join(dir, "agent.db");
  const failures: StoreRecoveryRequired[] = [];
  let store = openSqliteStore(path, { onRecoveryRequired: (error) => failures.push(error) });
  const control = new Database(path);
  try {
    // The archive is already fsynced when its SQLite marker is updated.
    control.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON archive_state BEGIN SELECT RAISE(FAIL, 'injected commit failure'); END;");
    expect(() => store.transaction(() => {
      store.append({ type: "inception", summary: "new code", payload: { promotion: "committed" }, at: 1 });
      replies(store);
      store.writeSnapshot({ asOfSeq: 2, at: 3, state: { current: true } });
    })).toThrow(StoreRecoveryRequired);
    expect(failures).toHaveLength(1);
    expect(() => store.read(0)).toThrow(StoreRecoveryRequired);
    expect(() => store.readSnapshot()).toThrow(StoreRecoveryRequired);
    expect(() => store.readReply(terminal.id)).toThrow(StoreRecoveryRequired);
    expect(() => store.acceptMessage(request)).toThrow(StoreRecoveryRequired);
    expect(() => store.append(note("must not continue"))).toThrow(StoreRecoveryRequired);
    store.close();
    control.exec("DROP TRIGGER fail_commit;");
    store = openSqliteStore(path);
    expect([...allFrames(store)].map((frame) => frame.type)).toEqual(["inception", "reply"]);
    expect(store.readSnapshot()).toEqual({ asOfSeq: 2, at: 3, state: { current: true } });
    expect(store.readReply(terminal.id)).toEqual(terminal);
    expect(store.append(note("after recovery")).seq).toBe(3);
  } finally { control.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed archive publication rolls back SQLite and preserves no phantom reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-failed-"));
  const path = join(dir, "agent.db");
  let store = openSqliteStore(path);
  try {
    rmSync(archivePath(path), { recursive: true });
    writeFileSync(archivePath(path), "not a directory");
    expect(() => replies(store)).toThrow(StoreRecoveryRequired);
    store.close();
    rmSync(archivePath(path));
    store = openSqliteStore(path);
    expect(store.readReply(terminal.id)).toBeNull();
    expect([...allFrames(store)]).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("multiple connections allocate one archive order and incomplete copies fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-order-"));
  const path = join(dir, "agent.db");
  const first = openSqliteStore(path);
  const second = openSqliteStore(path);
  try {
    first.append(note("first"));
    second.append(note("second"));
    first.append(note("third"));
    expect([...allFrames(second)].map((frame) => frame.seq)).toEqual([1, 2, 3]);
  } finally { first.close(); second.close(); }
  try {
    const names = readdirSync(archivePath(path)).filter((name) => name.endsWith(".json")).sort();
    rmSync(join(archivePath(path), names[1]!));
    expect(() => openSqliteStore(path)).toThrow(/incomplete frame archive/);
    rmSync(archivePath(path), { recursive: true });
    expect(() => openSqliteStore(path)).toThrow(/missing commits/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SQLite-only stores are rejected without exporting or modifying their history", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-legacy-"));
  const path = join(dir, "agent.db");
  const legacy = new Database(path, { create: true });
  legacy.exec(`CREATE TABLE frames (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, id TEXT, payload TEXT);
    CREATE TABLE snapshot (id INTEGER PRIMARY KEY, as_of_seq INTEGER NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL);
    INSERT INTO frames (at, type, summary) VALUES (1, 'note', 'legacy');
    INSERT INTO snapshot VALUES (1, 1, 2, '{"legacy":true}');`);
  legacy.close();
  try {
    const before = readFileSync(path);
    expect(() => openSqliteStore(path)).toThrow(/SQLite-only stores are unsupported/);
    expect(existsSync(archivePath(path))).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    const unchanged = new Database(path, { readonly: true });
    try {
      expect(unchanged.query("SELECT summary FROM frames").all()).toEqual([{ summary: "legacy" }]);
      expect(unchanged.query("SELECT state FROM snapshot").get()).toEqual({ state: '{"legacy":true}' });
      expect(unchanged.query("SELECT name FROM sqlite_master WHERE name = 'archive_state'").get()).toBeNull();
    } finally { unchanged.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
