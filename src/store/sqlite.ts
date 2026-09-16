import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";
import { appendCommit, archivePath, checkpointPath, ensureArchive, readAfter, readLayout, syncDirectory, truncateSegment, type ArchiveCommit, type ArchiveCursor, type SegmentPolicy } from "./archive.ts";
import { isMessage, isTerminal, PROTOCOL_VERSION, type Delivered, type Message, type Reply } from "../protocol/wire.ts";

export { archivePath, checkpointPath } from "./archive.ts";
export function hasPersistedStore(path: string): boolean {
  return existsSync(path) || existsSync(checkpointPath(path)) || existsSync(archivePath(path));
}

/** A commit may have reached the authoritative archive. Reopen before doing any further work. */
export class StoreRecoveryRequired extends Error {
  constructor(cause: unknown) {
    super(`frame store requires recovery: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StoreRecoveryRequired";
  }
}

/** SQLite holds the runtime inbox and indexes the immutable filesystem log. */
export interface AgentStore extends FrameStore {
  /**
   * The live connection. Framework indexes maintained by other modules run
   * their SQL inside `transaction`, so they commit with the frames they index.
   * Program-owned tables share this file; nothing here isolates them, and an
   * archive-only rebuild restores only what the archive records.
   */
  readonly database: Database;
  acceptMessage(message: Delivered<Message>): boolean;
  /** Appending a request/call frame marks its messages delivered, on live writes and replay alike. */
  readMessage(id: string): Delivered<Message> | null;
  pendingMessages(): Delivered<Message>[];
  /** Commit the reply and its full frame together; a terminal reply can never be replaced. */
  commitReply(reply: Reply, frame: FrameInput): boolean;
  readReply(id: string): Reply | null;
  replies(): Reply[];
}

export interface StoreOptions {
  onRecoveryRequired?(error: StoreRecoveryRequired): void;
  /** Index one frame; called for live appends and archive replay alike, inside the same transaction. */
  index?(frame: Frame, db: Database): void;
  /** Segment rotation thresholds; the default is `SEGMENT_POLICY`. */
  segment?: SegmentPolicy;
}

/**
 * The filesystem archive is the durable commit decision for frames and
 * instance checkpoints. SQLite owns pending delivery and provides query
 * indexes; deleting it rebuilds history, checkpoints, deduplication and
 * canonical replies from the archive, starting from `checkpoint.db` when one
 * is beside it. Acceptance without a delivered frame exists only in SQLite
 * and is deliberately outside archive-only backups.
 */
export function openSqliteStore(path: string, options: StoreOptions = {}): AgentStore {
  if (!existsSync(path) && existsSync(checkpointPath(path))) restoreCheckpoint(path);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  const archive = archivePath(path);
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frames'").get()
    && !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_state'").get()) {
    db.close();
    throw new StoreRecoveryRequired("SQLite-only stores are unsupported; start with a new agent directory");
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      type TEXT NOT NULL, summary TEXT NOT NULL, id TEXT, payload TEXT
    );
    CREATE INDEX IF NOT EXISTS frames_id ON frames (id, seq);
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1), as_of_seq INTEGER NOT NULL,
      at INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY, reply TEXT NOT NULL, terminal INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), commit_no INTEGER NOT NULL,
      segment TEXT, offset INTEGER NOT NULL DEFAULT 0, frames INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO archive_state (id, commit_no) VALUES (1, 0);
  `);
  // An index written before segments existed carries only the commit number.
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(archive_state)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("segment")) db.exec("ALTER TABLE archive_state ADD COLUMN segment TEXT; ALTER TABLE archive_state ADD COLUMN offset INTEGER NOT NULL DEFAULT 0; ALTER TABLE archive_state ADD COLUMN frames INTEGER NOT NULL DEFAULT 0;");
  }).immediate();
  const insert = db.prepare("INSERT INTO frames (at, type, summary, id, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq");
  const select = db.prepare("SELECT seq, at, type, summary, id, payload FROM frames WHERE seq > ? ORDER BY seq ASC LIMIT ?");
  const toFrame = (row: Record<string, unknown>): Frame => ({
    seq: row.seq as number, at: row.at as number, type: row.type as string, summary: row.summary as string,
    id: (row.id as string | null) ?? undefined,
    payload: row.payload == null ? undefined : JSON.parse(row.payload as string),
  });
  const lastSeq = () => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM frames").get() as { seq: number }).seq;
  const cursor = (): ArchiveCursor => {
    const row = db.query("SELECT commit_no, segment, offset, frames FROM archive_state WHERE id = 1").get() as { commit_no: number; segment: string | null; offset: number; frames: number };
    return { commit: row.commit_no, segment: row.segment, offset: row.offset, frames: row.frames };
  };
  const saveCursor = (c: ArchiveCursor) => db.query("UPDATE archive_state SET commit_no = ?, segment = ?, offset = ?, frames = ? WHERE id = 1").run(c.commit, c.segment, c.offset, c.frames);
  const readSnapshot = (): Snapshot | null => {
    const row = db.query("SELECT as_of_seq, at, state FROM snapshot WHERE id = 1").get() as { as_of_seq: number; at: number; state: string } | null;
    return row ? { asOfSeq: row.as_of_seq, at: row.at, state: JSON.parse(row.state) } : null;
  };
  const putSnapshot = (s: Snapshot) => db.query(`INSERT INTO snapshot (id, as_of_seq, at, state) VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET as_of_seq=excluded.as_of_seq, at=excluded.at, state=excluded.state`).run(s.asOfSeq, s.at, JSON.stringify(s.state));
  const putReply = (reply: Reply) => db.query(`INSERT INTO replies (id, reply, terminal) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET reply=excluded.reply, terminal=excluded.terminal
    WHERE replies.terminal = 0 AND replies.reply <> excluded.reply`).run(reply.id, JSON.stringify(reply), Number(isTerminal(reply.state))).changes === 1;

  /** Wire outcomes are already full harness frames; no second receipt log. The one fold for live writes and replay. */
  const indexFrame = (frame: Frame) => {
    const payload = frame.payload as Record<string, any> | undefined;
    const delivered = (message: Delivered<Message>) => {
      if (!isMessage(message) || typeof message.from !== "string") return;
      db.query(`INSERT INTO inbox (id, message, delivered) VALUES (?, ?, 1)
        ON CONFLICT (id) DO UPDATE SET delivered = 1`).run(message.id, JSON.stringify(message));
    };
    if (frame.type === "request") for (const message of payload?.metadata?.endo?.requests ?? []) delivered(message);
    if (["notification", "rejected-message"].includes(frame.type) && payload) delivered(payload as Delivered<Message>);
    if (frame.type === "call" && frame.id && payload) delivered({
      v: PROTOCOL_VERSION, kind: "call", id: frame.id, procedure: payload.procedure,
      args: payload.args ?? {}, from: payload.from, at: frame.at,
    });
    if (frame.type === "reply" && frame.id && payload && typeof payload.state === "string" && typeof payload.text === "string") {
      putReply({ from: payload.from, to: payload.to, v: PROTOCOL_VERSION, id: frame.id, ok: !!payload.ok, state: payload.state, text: payload.text, at: payload.at ?? frame.at } as Reply);
    }
    options.index?.(frame, db);
  };

  const applyCommit = (entry: ArchiveCommit) => {
    let seq = lastSeq();
    for (const frame of entry.frames) {
      if (frame.seq !== seq + 1 || !Number.isFinite(frame.at) || typeof frame.type !== "string" || typeof frame.summary !== "string") throw new Error(`invalid frame sequence in archive commit ${entry.commit}: expected ${seq + 1}`);
      db.query("INSERT INTO frames (seq, at, type, summary, id, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(frame.seq, frame.at, frame.type, frame.summary, frame.id ?? null, frame.payload === undefined ? null : JSON.stringify(frame.payload));
      indexFrame(frame);
      seq = frame.seq;
    }
    if (entry.snapshot) {
      if (!Number.isSafeInteger(entry.snapshot.asOfSeq) || entry.snapshot.asOfSeq < 0 || entry.snapshot.asOfSeq > seq) throw new Error(`invalid checkpoint boundary in archive commit ${entry.commit}`);
      putSnapshot(entry.snapshot);
    }
  };
  /** Under the write lock: apply what the archive holds beyond the index, and drop an unterminated tail that no one can be writing. */
  const reconcile = (): ArchiveCursor => {
    const before = cursor();
    const result = readAfter(archive, before, applyCommit);
    if (result.torn) truncateSegment(result.torn.path, result.torn.keep);
    if (result.cursor.commit !== before.commit || result.cursor.segment !== before.segment) saveCursor(result.cursor);
    return result.cursor;
  };

  try {
    // Check the whole chain on open. A copied prefix is valid; an interior
    // gap, a corrupt tail before another segment, or an index newer than
    // the archive is not.
    if (cursor().commit > 0 && !existsSync(archive)) throw new Error("frame archive is missing commits already indexed by SQLite");
    ensureArchive(archive);
    db.transaction(() => {
      const layout = readLayout(archive);
      const indexed = cursor();
      if (indexed.commit > layout.head || (indexed.segment !== null && !layout.segments.includes(indexed.segment)))
        throw new Error("frame archive is missing commits already indexed by SQLite");
      if (indexed.commit === 0 && (lastSeq() > 0 || readSnapshot()))
        throw new Error("SQLite-only stores are unsupported; start with a new agent directory");
      reconcile();
    }).immediate();
  } catch (error) {
    db.close();
    throw new StoreRecoveryRequired(error);
  }

  let recovery: StoreRecoveryRequired | undefined;
  const assertUsable = () => { if (recovery) throw recovery; };
  const poison = (cause: unknown): never => {
    if (!recovery) {
      recovery = cause instanceof StoreRecoveryRequired ? cause : new StoreRecoveryRequired(cause);
      try { options.onRecoveryRequired?.(recovery); } catch {}
    }
    throw recovery;
  };
  type Pending = { frames: Frame[]; snapshot?: Snapshot };
  let pending: Pending | undefined;
  const store: AgentStore = {
    database: db,
    transaction<T>(write: () => T): T {
      assertUsable();
      const parent = pending;
      const batch: Pending = { frames: [] };
      let started = false;
      let publishing = false;
      let reconciling = false;
      pending = batch;
      try {
        const result = db.transaction(() => {
          started = true;
          if (!parent) {
            reconciling = true;
            reconcile();
            reconciling = false;
          }
          const value = write();
          if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("store transactions must be synchronous");
          if (!parent && (batch.frames.length || batch.snapshot)) {
            publishing = true;
            const at = cursor();
            const entry: ArchiveCommit = { version: 1, commit: at.commit + 1, frames: batch.frames, ...(batch.snapshot ? { snapshot: batch.snapshot } : {}) };
            saveCursor(appendCommit(archive, at, entry, options.segment));
          }
          return value;
        }).immediate();
        if (parent) {
          parent.frames.push(...batch.frames);
          if (batch.snapshot) parent.snapshot = batch.snapshot;
        }
        return result;
      } catch (error) {
        // BEGIN itself was refused (another writer holds the file): nothing
        // ran and nothing changed, so the caller may simply try again.
        if (!started) throw error;
        // Once publication starts, absence/presence may be uncertain to the
        // caller. Stop using both the database and the mutated machine.
        const sqliteFailure = error && typeof error === "object" && "code" in error && String(error.code).startsWith("SQLITE_");
        if (publishing || reconciling || sqliteFailure || error instanceof StoreRecoveryRequired) return poison(error);
        throw error;
      } finally {
        pending = parent;
      }
    },
    append(frame) {
      assertUsable();
      // Canonicalize before writing so caller mutations cannot alter an
      // archive batch after its corresponding SQLite row was inserted.
      const payload = frame.payload === undefined ? undefined : JSON.stringify(frame.payload);
      const canonical = { ...frame, ...(payload === undefined ? {} : { payload: JSON.parse(payload) }) };
      return store.transaction(() => {
        const row = insert.get(frame.at, frame.type, frame.summary, frame.id ?? null, payload ?? null) as { seq: number };
        const stored = { ...canonical, seq: row.seq };
        indexFrame(stored);
        pending!.frames.push(structuredClone(stored));
        return stored;
      });
    },
    read(fromSeq, limit = 1000) { assertUsable(); return (select.all(fromSeq, limit) as Record<string, unknown>[]).map(toFrame); },
    lastSeq() { assertUsable(); return lastSeq(); },
    writeSnapshot(snapshot) {
      assertUsable();
      const canonical = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
      store.transaction(() => {
        if (!Number.isSafeInteger(canonical.asOfSeq) || canonical.asOfSeq < 0 || canonical.asOfSeq > lastSeq()) throw new Error("snapshot boundary exceeds committed frames");
        putSnapshot(canonical);
        pending!.snapshot = canonical;
      });
    },
    readSnapshot() { assertUsable(); return readSnapshot(); },
    acceptMessage(message) {
      assertUsable();
      return store.transaction(() => db.query("INSERT OR IGNORE INTO inbox (id, message) VALUES (?, ?)").run(message.id, JSON.stringify(message)).changes === 1);
    },
    readMessage(id) {
      assertUsable();
      const row = db.query("SELECT message FROM inbox WHERE id = ?").get(id) as { message: string } | null;
      return row ? JSON.parse(row.message) : null;
    },
    pendingMessages() {
      assertUsable();
      return (db.query("SELECT message FROM inbox WHERE delivered = 0 ORDER BY rowid").all() as { message: string }[]).map((row) => JSON.parse(row.message));
    },
    commitReply(reply, frame) {
      assertUsable();
      return store.transaction(() => {
        const changed = putReply(reply);
        if (changed) store.append(frame);
        return changed;
      });
    },
    readReply(id) {
      assertUsable();
      const row = db.query("SELECT reply FROM replies WHERE id = ?").get(id) as { reply: string } | null;
      return row ? JSON.parse(row.reply) : null;
    },
    replies() {
      assertUsable();
      return (db.query("SELECT reply FROM replies ORDER BY rowid").all() as { reply: string }[]).map((row) => JSON.parse(row.reply));
    },
    close() { db.close(); },
  };
  return store;
}

/**
 * Write `checkpoint.db`: a consistent copy of the live database taken after
 * the index caught up with the archive, so the archive never trails it. The
 * copy carries every table in the file, including program-owned ones, and
 * records the archive commit it stands at. Returns that position.
 */
export function checkpointStore(path: string, options: StoreOptions = {}): ArchiveCursor {
  const store = openSqliteStore(path, options);
  const checkpoint = checkpointPath(path);
  const temporary = `${checkpoint}.${crypto.randomUUID()}.tmp`;
  try {
    store.database.run("VACUUM INTO ?", [temporary]);
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, checkpoint);
    syncDirectory(dirname(checkpoint));
  } finally {
    store.close();
    rmSync(temporary, { force: true });
  }
  return checkpointCursor(checkpoint);
}

/** The archive position a checkpoint file stands at. */
export function checkpointCursor(checkpoint: string): ArchiveCursor {
  const db = new Database(checkpoint, { readonly: true });
  try {
    const row = db.query("SELECT commit_no, segment, offset, frames FROM archive_state WHERE id = 1").get() as { commit_no: number; segment: string | null; offset: number; frames: number } | null;
    if (!row) throw new Error(`${checkpoint} is not a store checkpoint`);
    return { commit: row.commit_no, segment: row.segment, offset: row.offset, frames: row.frames };
  } finally {
    db.close();
  }
}

/**
 * No live database: start from the checkpoint. The checkpoint file itself
 * serialises concurrent restorers; the first to link the copy wins and stale
 * WAL/SHM companions of the missing database go first, so recovery cannot
 * replay them onto the copy.
 */
function restoreCheckpoint(path: string): void {
  const checkpoint = checkpointPath(path);
  const guard = new Database(checkpoint);
  try {
    guard.exec("PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE;");
    if (existsSync(path)) return;
    for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      copyFileSync(checkpoint, temporary);
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      linkSync(temporary, path);
      syncDirectory(dirname(path));
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    try { guard.exec("COMMIT;"); } catch {}
    guard.close();
  }
}
