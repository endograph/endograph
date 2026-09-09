import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";
import { archivePath, commitNumbers, commitPath, ensureArchive, publishCommit, readCommit, type ArchiveCommit } from "./archive.ts";
import { isMessage, isTerminal, PROTOCOL_VERSION, type Delivered, type Message, type Reply } from "../protocol/wire.ts";

export { archivePath } from "./archive.ts";
export function hasPersistedStore(path: string): boolean {
  return existsSync(path) || existsSync(archivePath(path));
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
  acceptMessage(message: Delivered<Message>): boolean;
  /** Appending a request/call frame marks its messages delivered, on live writes and replay alike. */
  readMessage(id: string): Delivered<Message> | null;
  pendingMessages(): Delivered<Message>[];
  /** Commit the reply and its full frame together; a terminal reply can never be replaced. */
  commitReply(reply: Reply, frame: FrameInput): boolean;
  readReply(id: string): Reply | null;
  replies(): Reply[];
}

/**
 * The filesystem archive is the durable commit decision for frames and
 * instance checkpoints. SQLite owns pending delivery and provides query
 * indexes; deleting it rebuilds history, checkpoints, deduplication and
 * canonical replies from the archive. Acceptance without a delivered frame
 * exists only in SQLite and is deliberately outside archive-only backups.
 */
export function openSqliteStore(path: string, options: { onRecoveryRequired?(error: StoreRecoveryRequired): void } = {}): AgentStore {
  const db = new Database(path, { create: true });
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
      id INTEGER PRIMARY KEY CHECK (id = 1), commit_no INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO archive_state (id, commit_no) VALUES (1, 0);
  `);
  const insert = db.prepare("INSERT INTO frames (at, type, summary, id, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq");
  const select = db.prepare("SELECT seq, at, type, summary, id, payload FROM frames WHERE seq > ? ORDER BY seq ASC LIMIT ?");
  const toFrame = (row: Record<string, unknown>): Frame => ({
    seq: row.seq as number, at: row.at as number, type: row.type as string, summary: row.summary as string,
    id: (row.id as string | null) ?? undefined,
    payload: row.payload == null ? undefined : JSON.parse(row.payload as string),
  });
  const lastSeq = () => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM frames").get() as { seq: number }).seq;
  const indexedCommit = () => (db.query("SELECT commit_no FROM archive_state WHERE id = 1").get() as { commit_no: number }).commit_no;
  const markCommit = (commit: number) => db.query("UPDATE archive_state SET commit_no = ? WHERE id = 1").run(commit);
  const readSnapshot = (): Snapshot | null => {
    const row = db.query("SELECT as_of_seq, at, state FROM snapshot WHERE id = 1").get() as { as_of_seq: number; at: number; state: string } | null;
    return row ? { asOfSeq: row.as_of_seq, at: row.at, state: JSON.parse(row.state) } : null;
  };
  const putSnapshot = (s: Snapshot) => db.query(`INSERT INTO snapshot (id, as_of_seq, at, state) VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET as_of_seq=excluded.as_of_seq, at=excluded.at, state=excluded.state`).run(s.asOfSeq, s.at, JSON.stringify(s.state));
  const putReply = (reply: Reply) => db.query(`INSERT INTO replies (id, reply, terminal) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET reply=excluded.reply, terminal=excluded.terminal
    WHERE replies.terminal = 0 AND replies.reply <> excluded.reply`).run(reply.id, JSON.stringify(reply), Number(isTerminal(reply.state))).changes === 1;

  /** Wire outcomes are already full harness frames; no second receipt log. */
  const indexWireFrame = (frame: Frame) => {
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
  };

  const applyCommit = (entry: ArchiveCommit) => {
    let seq = lastSeq();
    for (const frame of entry.frames) {
      if (frame.seq !== seq + 1 || !Number.isFinite(frame.at) || typeof frame.type !== "string" || typeof frame.summary !== "string") throw new Error(`invalid frame sequence in archive commit ${entry.commit}: expected ${seq + 1}`);
      db.query("INSERT INTO frames (seq, at, type, summary, id, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(frame.seq, frame.at, frame.type, frame.summary, frame.id ?? null, frame.payload === undefined ? null : JSON.stringify(frame.payload));
      indexWireFrame(frame);
      seq = frame.seq;
    }
    if (entry.snapshot) {
      if (!Number.isSafeInteger(entry.snapshot.asOfSeq) || entry.snapshot.asOfSeq < 0 || entry.snapshot.asOfSeq > seq) throw new Error(`invalid checkpoint boundary in archive commit ${entry.commit}`);
      putSnapshot(entry.snapshot);
    }
    markCommit(entry.commit);
  };
  const reconcile = () => {
    let next = indexedCommit() + 1;
    while (existsSync(commitPath(archive, next))) applyCommit(readCommit(archive, next++));
  };

  try {
    // Check the entire filename chain on open. A copied prefix is valid;
    // an interior gap or an index newer than the archive is not.
    if (indexedCommit() > 0 && !existsSync(archive)) throw new Error("frame archive is missing commits already indexed by SQLite");
    ensureArchive(archive);
    db.transaction(() => {
      const numbers = commitNumbers(archive);
      if (indexedCommit() > numbers.length) throw new Error("frame archive is missing commits already indexed by SQLite");
      if (indexedCommit() === 0 && (lastSeq() > 0 || readSnapshot()))
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
    transaction<T>(write: () => T): T {
      assertUsable();
      const parent = pending;
      const batch: Pending = { frames: [] };
      let publishing = false;
      let reconciling = false;
      pending = batch;
      try {
        const result = db.transaction(() => {
          if (!parent) {
            reconciling = true;
            reconcile();
            reconciling = false;
          }
          const value = write();
          if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("store transactions must be synchronous");
          if (!parent && (batch.frames.length || batch.snapshot)) {
            publishing = true;
            const entry: ArchiveCommit = { version: 1, commit: indexedCommit() + 1, frames: batch.frames, ...(batch.snapshot ? { snapshot: batch.snapshot } : {}) };
            publishCommit(archive, entry);
            markCommit(entry.commit);
          }
          return value;
        }).immediate();
        if (parent) {
          parent.frames.push(...batch.frames);
          if (batch.snapshot) parent.snapshot = batch.snapshot;
        }
        return result;
      } catch (error) {
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
        indexWireFrame(stored);
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
