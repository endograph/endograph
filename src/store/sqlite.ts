import { Database } from "bun:sqlite";
import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";

/**
 * SQLite backend: one file in the state directory. Copy it, back it up,
 * attach it to a bug report; the frame log is a plain table for `sqlite3`.
 * The envelope is mirrored into columns; the payload column holds the full
 * projector frame. Writing the snapshot checkpoints the WAL into the main
 * file, so between activations `agent.db` alone is the whole log and a
 * copy of it is consistent.
 */
export function openSqliteStore(path: string): FrameStore {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      summary TEXT NOT NULL,
      id      TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS frames_id ON frames (id, seq);
    CREATE TABLE IF NOT EXISTS snapshot (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      as_of_seq INTEGER NOT NULL,
      at        INTEGER NOT NULL,
      state     TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO frames (at, type, summary, id, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq`);
  const select = db.prepare(`SELECT seq, at, type, summary, id, payload FROM frames WHERE seq > ? ORDER BY seq ASC LIMIT ?`);
  const toFrame = (row: Record<string, unknown>): Frame => ({
    seq: row.seq as number,
    at: row.at as number,
    type: row.type as string,
    summary: row.summary as string,
    id: (row.id as string | null) ?? undefined,
    payload: row.payload == null ? undefined : JSON.parse(row.payload as string),
  });

  return {
    append(frame: FrameInput): Frame {
      const row = insert.get(
        frame.at,
        frame.type,
        frame.summary,
        frame.id ?? null,
        frame.payload === undefined ? null : JSON.stringify(frame.payload),
      ) as { seq: number };
      return { ...frame, seq: row.seq };
    },
    read(fromSeq, limit = 1000) {
      return (select.all(fromSeq, limit) as Record<string, unknown>[]).map(toFrame);
    },
    lastSeq() {
      return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM frames").get() as { seq: number }).seq;
    },
    writeSnapshot(s: Snapshot) {
      db.prepare(
        `INSERT INTO snapshot (id, as_of_seq, at, state) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET as_of_seq = excluded.as_of_seq, at = excluded.at, state = excluded.state`,
      ).run(s.asOfSeq, s.at, JSON.stringify(s.state));
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    },
    readSnapshot() {
      const row = db.prepare("SELECT as_of_seq, at, state FROM snapshot WHERE id = 1").get() as
        | { as_of_seq: number; at: number; state: string }
        | null;
      return row ? { asOfSeq: row.as_of_seq, at: row.at, state: JSON.parse(row.state) } : null;
    },
    close() {
      db.close();
    },
  };
}
