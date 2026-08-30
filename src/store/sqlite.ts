import { Database } from "bun:sqlite";
import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";

/**
 * v1 backend: a single SQLite db at the heart of the agent directory.
 * Copy it, back it up, diff it, attach it to a bug report. The frame log
 * is a plain table queryable with `sqlite3`.
 */
export function openSqliteStore(path: string): FrameStore {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      at       INTEGER NOT NULL,
      type     TEXT NOT NULL,
      subject  TEXT,
      summary  TEXT NOT NULL,
      incident TEXT,
      payload  TEXT
    );
    CREATE INDEX IF NOT EXISTS frames_subject ON frames (subject, seq);
    CREATE INDEX IF NOT EXISTS frames_incident ON frames (incident, seq);
    CREATE TABLE IF NOT EXISTS snapshot (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      as_of_seq INTEGER NOT NULL,
      at       INTEGER NOT NULL,
      state    TEXT NOT NULL
    );
  `);

  const insert = db.prepare(
    `INSERT INTO frames (at, type, subject, summary, incident, payload)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
  );
  const select = db.prepare(
    `SELECT seq, at, type, subject, summary, incident, payload
     FROM frames WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
  );

  const rowToFrame = (row: Record<string, unknown>): Frame => ({
    seq: row.seq as number,
    at: row.at as number,
    type: row.type as string,
    subject: (row.subject as string | null) ?? undefined,
    summary: row.summary as string,
    incident: (row.incident as string | null) ?? undefined,
    payload:
      row.payload == null ? undefined : JSON.parse(row.payload as string),
  });

  return {
    append(frame: FrameInput): Frame {
      const row = insert.get(
        frame.at,
        frame.type,
        frame.subject ?? null,
        frame.summary,
        frame.incident ?? null,
        frame.payload === undefined ? null : JSON.stringify(frame.payload),
      ) as { seq: number };
      return { ...frame, seq: row.seq };
    },

    read(fromSeq: number, limit = 1000): Frame[] {
      const rows = select.all(fromSeq, limit) as Record<string, unknown>[];
      return rows.map(rowToFrame);
    },

    lastSeq(): number {
      const row = db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM frames")
        .get() as { seq: number };
      return row.seq;
    },

    writeSnapshot(snapshot: Snapshot): void {
      db.prepare(
        `INSERT INTO snapshot (id, as_of_seq, at, state) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET as_of_seq = excluded.as_of_seq,
           at = excluded.at, state = excluded.state`,
      ).run(snapshot.asOfSeq, snapshot.at, JSON.stringify(snapshot.state));
    },

    readSnapshot(): Snapshot | null {
      const row = db
        .prepare("SELECT as_of_seq, at, state FROM snapshot WHERE id = 1")
        .get() as { as_of_seq: number; at: number; state: string } | null;
      if (!row) return null;
      return { asOfSeq: row.as_of_seq, at: row.at, state: JSON.parse(row.state) };
    },

    close(): void {
      db.close();
    },
  };
}
