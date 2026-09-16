import type { Database } from "bun:sqlite";
import { isMessage, newId, type Delivered, type Message } from "../protocol/wire.ts";
import type { AgentStore } from "./sqlite.ts";
import type { Frame } from "./types.ts";

export interface Thread { id: string; title: string; createdAt: number; updatedAt: number; archived: boolean; metadata: Record<string, unknown> }
export interface ConversationMessage { key: string; id: string; seq: number; at: number; kind: string; threadId?: string; from?: string; text: string; state?: string }
export function threadId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error("Invalid thread ID");
}
export function boundedText(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new Error(`Invalid ${name} (maximum ${max} characters)`);
  return value.trim();
}
export function pageLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 200) throw new Error("limit must be between 1 and 200");
  return Number(value);
}
export function cursor(value: unknown): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Invalid history cursor");
  return Number(value);
}
/** A projection of recorded thread/message events. No principals, permissions, or agent execution. */
export function threadStore(store: AgentStore) {
  const db: Database = store.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_messages (
      key TEXT PRIMARY KEY, request_id TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      thread_id TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, sender TEXT, text TEXT NOT NULL, state TEXT
    );
    CREATE INDEX IF NOT EXISTS thread_messages_page ON thread_messages(thread_id, seq);
    CREATE INDEX IF NOT EXISTS thread_messages_request ON thread_messages(request_id, kind);
    CREATE TABLE IF NOT EXISTS thread_index (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
    INSERT OR IGNORE INTO thread_index VALUES (1, 0);
  `);
  const get = (id: string): Thread | null => {
    const row = db.query("SELECT value FROM threads WHERE id=?").get(id) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  };
  const put = (t: Thread) => db.query("INSERT INTO threads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(t.id, JSON.stringify(t));
  function indexMessage(m: any, f: Frame, ordinal: number) {
    if (!m || typeof m.id !== "string" || typeof m.kind !== "string") return;
    const id = typeof m.thread === "string" ? m.thread : undefined;
    if (id) {
      threadId(id);
      const thread = get(id);
      put(thread ? { ...thread, updatedAt: Math.max(thread.updatedAt, f.at) } : { id, title: "Untitled", createdAt: f.at, updatedAt: f.at, archived: false, metadata: {} });
    }
    const key = `${m.kind}:${m.id}`;
    const text = typeof m.text === "string" ? m.text : `${m.procedure ?? "call"} ${JSON.stringify(m.args ?? {})}`;
    db.query(`INSERT INTO thread_messages VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      thread_id=COALESCE(excluded.thread_id,thread_messages.thread_id), sender=COALESCE(excluded.sender,thread_messages.sender), state=excluded.state`).run(
      key, m.id, f.seq, ordinal, id ?? null, m.kind, m.at ?? f.at, m.from ?? null, text, f.type === "message-queued" ? "queued" : null);
  }
  function index(f: Frame) {
    const p = f.payload as any;
    if (f.type === "thread" && p?.id) { threadId(p.id); put(p as Thread); }
    if (f.type === "message-queued") {
      if (isMessage(p) && typeof p.from === "string" && !store.readMessage(p.id)) store.acceptMessage(p as Delivered<Message>);
      indexMessage(p, f, 0);
    }
    if (f.type === "request") for (const [i, m] of (p?.metadata?.endo?.requests ?? []).entries()) indexMessage(m, f, i);
    if (f.type === "call" && f.id) indexMessage({ ...p, id: f.id, kind: "call", at: f.at }, f, 0);
    if (f.type === "notification") indexMessage(p, f, 0);
    if (f.type === "reply" && f.id && typeof p?.text === "string") {
      const request = db.query("SELECT thread_id FROM thread_messages WHERE request_id=? AND kind IN ('request','call') LIMIT 1").get(f.id) as { thread_id: string | null } | null;
      const id = request?.thread_id ?? p.thread ?? null;
      db.query("INSERT OR IGNORE INTO thread_messages VALUES (?,?,?,?,?,?,?,?,?,?)").run(`reply:${f.seq}`, f.id, f.seq, 0, id, "reply", p.at ?? f.at, p.from ?? null, p.text, p.state ?? null);
      if (id) { const t = get(id); if (t) put({ ...t, updatedAt: Math.max(t.updatedAt, f.at) }); }
    }
  }
  function sync() {
    let seq = (db.query("SELECT seq FROM thread_index WHERE id=1").get() as { seq: number }).seq;
    for (;;) {
      const frames = store.read(seq, 250);
      if (!frames.length) break;
      for (const f of frames) index(f);
      seq = frames.at(-1)!.seq;
    }
    db.query("UPDATE thread_index SET seq=? WHERE id=1").run(seq);
  }
  const transaction = <T>(fn: () => T): T => store.transaction(() => { sync(); return fn(); });
  function record(thread: Thread) {
    store.append({ type: "thread", summary: `thread ${thread.id}: ${thread.title}`, at: thread.updatedAt, payload: thread });
    sync();
    return thread;
  }
  return {
    list() { return transaction(() => (db.query("SELECT value FROM threads ORDER BY json_extract(value,'$.updatedAt') DESC, id").all() as { value: string }[]).map(r => JSON.parse(r.value) as Thread)); },
    get(id: string) { threadId(id); return transaction(() => get(id)); },
    create(input: { id?: string; title?: string; metadata?: Record<string, unknown> }) {
      const id = input.id ?? newId(); threadId(id);
      const title = boundedText(input.title ?? "Untitled", "title", 200, true) || "Untitled";
      const metadata = validMetadata(input.metadata ?? {});
      return transaction(() => get(id) ?? record({ id, title, metadata, createdAt: Date.now(), updatedAt: Date.now(), archived: false }));
    },
    update(id: string, input: { title?: string; archived?: boolean; metadata?: Record<string, unknown> }) {
      threadId(id);
      if (input.archived !== undefined && typeof input.archived !== "boolean") throw new Error("Invalid archived value");
      const title = input.title === undefined ? undefined : boundedText(input.title, "title", 200);
      const metadata = input.metadata === undefined ? undefined : validMetadata(input.metadata);
      return transaction(() => {
        const t = get(id); if (!t) throw new Error("Thread not found");
        return record({ ...t, ...(title === undefined ? {} : { title }), ...(input.archived === undefined ? {} : { archived: input.archived }), ...(metadata === undefined ? {} : { metadata: { ...t.metadata, ...metadata } }), updatedAt: Date.now() });
      });
    },
    send(message: Delivered<Message>) {
      if (!isMessage(message)) throw new Error("Invalid message");
      const id = message.thread; threadId(id);
      return transaction(() => {
        if (!get(id)) throw new Error("Thread not found");
        const previous = store.readMessage(message.id);
        if (previous) {
          if (previous.thread !== id || previous.kind !== message.kind || (previous as any).text !== (message as any).text) throw new Error("Message ID already used for different content");
          return { id: message.id };
        }
        store.acceptMessage(message);
        store.append({ type: "message-queued", id: message.id, at: message.at, summary: `queued ${message.kind}`, payload: message });
        sync(); return { id: message.id };
      });
    },
    messages(input: { threadId?: string; before?: number; limit?: number } = {}) {
      if (input.threadId !== undefined) threadId(input.threadId);
      const before = cursor(input.before), limit = pageLimit(input.limit);
      return transaction(() => {
        const args: (string | number)[] = [before];
        const where = `seq < ?${input.threadId === undefined ? "" : " AND thread_id=?"}`;
        if (input.threadId !== undefined) args.push(input.threadId);
        const rows = db.query(`SELECT DISTINCT seq FROM thread_messages WHERE ${where} ORDER BY seq DESC LIMIT ?`).all(...args, limit + 1) as { seq: number }[];
        const chosen = rows.slice(0, limit);
        if (!chosen.length) return { messages: [], nextBefore: null };
        const low = chosen.at(-1)!.seq;
        const data = db.query(`SELECT * FROM thread_messages WHERE ${where} AND seq >= ? ORDER BY seq, ordinal, key`).all(...args, low) as any[];
        return { messages: data.map(r => ({ key: r.key, id: r.request_id, seq: r.seq, at: r.at, kind: r.kind, ...(r.thread_id ? { threadId: r.thread_id } : {}), ...(r.sender ? { from: r.sender } : {}), text: r.text, ...(r.state ? { state: r.state } : {}) })) as ConversationMessage[], nextBefore: rows.length > limit ? low : null };
      });
    },
  };
}
function validMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 32768) throw new Error("Invalid thread metadata");
  return JSON.parse(JSON.stringify(value));
}
