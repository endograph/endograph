import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPath, checkpointStore, openSqliteStore, StoreRecoveryRequired } from "../src/store/sqlite.ts";
import { archivePath, commitNumbers, commitPath, copyArchive, publishCommit, readCommit, segmentName } from "../src/store/archive.ts";
import { allFrames } from "../src/store/types.ts";
import { PROTOCOL_VERSION, type CallMessage, type Delivered, type Reply, type RequestMessage } from "../src/protocol/wire.ts";

const request: Delivered<RequestMessage> = { v: PROTOCOL_VERSION, kind: "request", id: "request", text: "remember", from: "local:owner", at: 1 };
const terminal: Reply = { v: PROTOCOL_VERSION, id: "request", ok: true, state: "completed", text: "remembered", at: 3 };
const replies = (store: ReturnType<typeof openSqliteStore>, reply = terminal) => store.commitReply(reply, { type: "reply", id: reply.id, summary: reply.text, payload: reply, at: reply.at });
const note = (summary: string) => ({ type: "note", summary, at: 1 });
const segments = (path: string) => readdirSync(archivePath(path)).filter((name) => name.endsWith(".jsonl")).sort();
const records = (path: string, segment: string) => readFileSync(join(archivePath(path), segment), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const removeDatabase = (path: string) => { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true }); };

test("a copy of the archive rebuilds history, checkpoint, sender/dedup, canonical replies and indexes without a live database", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-"));
  const source = join(dir, "source");
  const copy = join(dir, "copy");
  mkdirSync(source);
  mkdirSync(copy);
  const indexed: number[] = [];
  const store = openSqliteStore(join(source, "agent.db"), { index: (frame) => { indexed.push(frame.seq); } });
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
    expect(indexed).toEqual([1, 2, 3, 4, 5]);

    const replayed: number[] = [];
    const restored = openSqliteStore(join(copy, "agent.db"), { index: (frame) => { replayed.push(frame.seq); } });
    try {
      expect([...allFrames(restored)]).toEqual(history);
      expect(replayed).toEqual([1, 2, 3, 4]);
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

test("an inception frame and checkpoint share one record; nested rollback publishes nothing", () => {
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
    expect(segments(path)).toEqual([segmentName(1)]);
    const [commit, ...rest] = records(path, segmentName(1));
    expect(rest).toEqual([]);
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
    // The archive is already fsynced when its SQLite cursor is updated.
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

test("a refused BEGIN leaves the store usable; multiple connections allocate one archive order", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-order-"));
  const path = join(dir, "agent.db");
  const first = openSqliteStore(path);
  const second = openSqliteStore(path);
  const control = new Database(path);
  try {
    first.database.exec("PRAGMA busy_timeout = 20");
    control.exec("BEGIN IMMEDIATE");
    let refused: unknown;
    try { first.append(note("blocked")); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(StoreRecoveryRequired);
    control.exec("COMMIT");
    first.append(note("first"));
    second.append(note("second"));
    first.append(note("third"));
    expect([...allFrames(second)].map((frame) => frame.summary)).toEqual(["first", "second", "third"]);
    expect(records(path, segmentName(1)).map((record) => record.commit)).toEqual([1, 2, 3]);
  } finally { control.close(); first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("segments rotate between transactions by frame count or bytes, never inside one", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-rotate-"));
  const path = join(dir, "agent.db");
  let store = openSqliteStore(path, { segment: { frames: 2, bytes: 1 << 30 } });
  try {
    for (const n of [1, 2, 3]) store.append(note(`single ${n}`));
    store.transaction(() => { for (const n of [4, 5, 6]) store.append(note(`batched ${n}`)); });
    store.append(note("single 7"));
    // The batch lands whole in the segment that still had room; the next transaction rotates.
    expect(segments(path)).toEqual([segmentName(1), segmentName(3), segmentName(5)]);
    expect(records(path, segmentName(3)).map((record) => record.frames.length)).toEqual([1, 3]);
    store.close();
    // Any connection continues where the archive stands, under its own policy.
    store = openSqliteStore(path, { segment: { frames: 1000, bytes: 200 } });
    for (const n of [8, 9, 10]) store.append(note(`long note ${n} ${"x".repeat(150)}`));
    expect(segments(path)).toEqual([segmentName(1), segmentName(3), segmentName(5), segmentName(7), segmentName(8)]);
    store.close();
    removeDatabase(path);
    store = openSqliteStore(path);
    expect([...allFrames(store)].map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(commitNumbers(archivePath(path))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readCommit(archivePath(path), 4).frames.map((frame) => frame.summary)).toEqual(["batched 4", "batched 5", "batched 6"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test.each(["", '{"version":1'])("recovery reuses a new segment interrupted before its first complete record (%s)", (partial) => {
  for (const prefix of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "endo-archive-empty-"));
    const path = join(dir, "agent.db");
    let store = openSqliteStore(path);
    try {
      if (prefix) store.append(note("committed"));
      store.close();
      const next = prefix ? 2 : 1;
      const segment = join(archivePath(path), segmentName(next));
      writeFileSync(segment, partial);
      store = openSqliteStore(path);
      expect(statSync(segment).size).toBe(0);
      expect(store.append(note("recovered")).seq).toBe(next);
      expect(records(path, segmentName(next)).map(r => r.commit)).toEqual([next]);
      store.close();
      removeDatabase(path);
      store = openSqliteStore(path);
      expect(store.lastSeq()).toBe(next);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("an unterminated tail is dropped under the write lock; everything else fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-tail-"));
  const path = join(dir, "agent.db");
  let store = openSqliteStore(path, { segment: { frames: 2, bytes: 1 << 30 } });
  const archive = archivePath(path);
  try {
    for (const n of [1, 2, 3]) store.append(note(`note ${n}`));
    store.close();
    const active = join(archive, segmentName(3));
    const size = statSync(active).size;
    appendFileSync(active, '{"version":1,"commit":3,"frames":[{"seq":4,"at":1,"type":"note","summary":"torn');
    store = openSqliteStore(path);
    expect(statSync(active).size).toBe(size);
    expect(store.append(note("note 4")).seq).toBe(4);
    expect(records(path, segmentName(3)).map((record) => record.commit)).toEqual([3, 4]);
    store.close();

    // A complete but invalid record is not a crash artefact.
    const goodActive = readFileSync(active);
    appendFileSync(active, "not json\n");
    expect(() => openSqliteStore(path)).toThrow(/corrupt frame archive/);
    writeFileSync(active, goodActive);
    // An unterminated record before a later segment is interior corruption.
    const earlier = join(archive, segmentName(1));
    const goodEarlier = readFileSync(earlier);
    appendFileSync(earlier, '{"version":1');
    expect(() => openSqliteStore(path)).toThrow(/corrupt frame archive/);
    writeFileSync(earlier, goodEarlier);
    // A rebuild reads every record, so an edited interior record fails closed too.
    const lines = records(path, segmentName(1));
    writeFileSync(earlier, [JSON.stringify({ ...lines[0], commit: 9 }), JSON.stringify(lines[1])].join("\n") + "\n");
    removeDatabase(path);
    expect(() => openSqliteStore(path)).toThrow(/corrupt frame archive: expected commit 1/);
    writeFileSync(earlier, goodEarlier);
    // A missing segment is an incomplete copy; an index past the archive is a shortened one.
    store = openSqliteStore(path, { segment: { frames: 2, bytes: 1 << 30 } });
    store.append(note("note 5"));
    store.close();
    expect(segments(path)).toEqual([segmentName(1), segmentName(3), segmentName(5)]);
    const middle = readFileSync(join(archive, segmentName(3)));
    rmSync(join(archive, segmentName(3)));
    removeDatabase(path);
    expect(() => openSqliteStore(path)).toThrow(/incomplete frame archive/);
    writeFileSync(join(archive, segmentName(3)), middle);
    openSqliteStore(path).close();
    rmSync(join(archive, segmentName(5)));
    expect(() => openSqliteStore(path)).toThrow(/missing commits/);
    rmSync(archive, { recursive: true });
    expect(() => openSqliteStore(path)).toThrow(/missing commits/);
    expect(existsSync(archive)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a legacy per-commit prefix stays byte for byte while new commits continue in segments", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-legacy-"));
  const path = join(dir, "agent.db");
  const archive = archivePath(path);
  mkdirSync(archive, { recursive: true });
  for (const commit of [1, 2]) publishCommit(archive, { version: 1, commit, frames: [{ seq: commit, at: commit, type: "note", summary: `legacy ${commit}` }], ...(commit === 2 ? { snapshot: { asOfSeq: 2, at: 2, state: { legacy: true } } } : {}) });
  const legacy = [1, 2].map((commit) => readFileSync(commitPath(archive, commit)));
  const store = openSqliteStore(path);
  try {
    expect([...allFrames(store)].map((frame) => frame.summary)).toEqual(["legacy 1", "legacy 2"]);
    expect(store.readSnapshot()).toEqual({ asOfSeq: 2, at: 2, state: { legacy: true } });
    store.append(note("first segment record"));
    expect(readdirSync(archive).sort()).toEqual(["00000000000000000001.json", "00000000000000000002.json", segmentName(3)]);
    expect([1, 2].map((commit) => readFileSync(commitPath(archive, commit)))).toEqual(legacy);
    expect(commitNumbers(archive)).toEqual([1, 2, 3]);
    expect(readCommit(archive, 1).frames[0]!.summary).toBe("legacy 1");
    expect(readCommit(archive, 3).frames[0]!.summary).toBe("first segment record");
  } finally { store.close(); }
  try {
    const cursor = checkpointStore(path);
    const copy = join(dir, "copy");
    copyArchive(archive, copy, cursor);
    expect(readdirSync(copy).sort()).toEqual(readdirSync(archive).sort());
    for (const name of readdirSync(archive)) expect(readFileSync(join(copy, name))).toEqual(readFileSync(join(archive, name)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checkpoint.db restores a missing database with program-owned tables, then the archive catches it up", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-archive-checkpoint-"));
  const path = join(dir, "agent.db");
  let store = openSqliteStore(path);
  try {
    store.database.exec("CREATE TABLE app_notes (k TEXT PRIMARY KEY, v TEXT)");
    store.transaction(() => {
      store.database.run("INSERT INTO app_notes VALUES ('kept', 'program data')");
      store.append(note("before checkpoint"));
    });
    store.close();
    const cursor = checkpointStore(path);
    expect(cursor).toMatchObject({ commit: 1, segment: segmentName(1) });
    expect(existsSync(checkpointPath(path))).toBe(true);
    store = openSqliteStore(path);
    store.append(note("after checkpoint"));
    store.close();
    removeDatabase(path);
    store = openSqliteStore(path);
    expect(store.database.query("SELECT v FROM app_notes").all()).toEqual([{ v: "program data" }]);
    expect([...allFrames(store)].map((frame) => frame.summary)).toEqual(["before checkpoint", "after checkpoint"]);
    store.close();
    // Without a checkpoint, only what the archive records comes back.
    removeDatabase(path);
    rmSync(checkpointPath(path));
    store = openSqliteStore(path);
    expect(store.database.query("SELECT name FROM sqlite_master WHERE name = 'app_notes'").get()).toBeNull();
    expect([...allFrames(store)].map((frame) => frame.summary)).toEqual(["before checkpoint", "after checkpoint"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
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
