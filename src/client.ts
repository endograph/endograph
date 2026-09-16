import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { userInfo } from "node:os";
import { inspectAgent } from "./harness/inspect.ts";
import { pathsOf } from "./harness/paths.ts";
import { openSqliteStore } from "./store/sqlite.ts";
import { boundedText, cursor, pageLimit, threadId, threadStore } from "./store/threads.ts";
import { PROTOCOL_VERSION } from "./protocol/wire.ts";
export type { Thread, ConversationMessage } from "./store/threads.ts";
export type { Frame, FrameInput } from "./store/types.ts";

/** Local client API. Applications own access control; this never loads agent code. */
export async function agentQuery(agentDir: string, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an operation object");
  const q = input as Record<string, any>;
  const paths = pathsOf(agentDir);
  mkdirSync(paths.state, { recursive: true });
  const store = openSqliteStore(paths.db);
  try {
    const threads = threadStore(store);
    switch (q.op) {
      case "threads.list": return { threads: threads.list() };
      case "threads.create": return threads.create({ id: q.id, title: q.title, metadata: q.metadata });
      case "threads.update": return threads.update(q.id, { title: q.title, archived: q.archived, metadata: q.metadata });
      case "messages.list": return threads.messages({ threadId: q.threadId, before: q.before, limit: q.limit });
      case "messages.send": {
        threadId(q.id); threadId(q.threadId);
        const text = boundedText(q.text, "message", 16000);
        return threads.send({ v: PROTOCOL_VERSION, id: q.id, kind: "request", thread: q.threadId, text, at: Date.now(), from: `local:${userInfo().username}` });
      }
      case "overview": {
        const info = await inspectAgent(paths, basename(agentDir));
        const pending = store.pendingMessages().filter(m => m.kind !== "notification");
        const open = new Set([...(info.status?.open ?? []), ...pending.map(m => m.id)]);
        return { name: info.name, phase: info.phase, reason: info.reason, totalFrames: store.lastSeq(), openRequests: open.size, runs: info.status?.runs ?? [], checkpoint: store.readSnapshot() };
      }
      case "frames.get": {
        const seq = cursor(q.seq); if (q.seq === undefined) throw new Error("seq is required");
        return store.read(seq - 1, 1).find(f => f.seq === seq) ?? null;
      }
      case "frames.list": {
        const before = cursor(q.before), limit = pageLimit(q.limit);
        const conditions: string[] = [], params: (string | number)[] = [];
        if (q.type !== undefined) { conditions.push("type=?"); params.push(boundedText(q.type, "frame type", 100)); }
        if (q.query !== undefined) { conditions.push("(instr(lower(summary),lower(?))>0 OR instr(lower(COALESCE(id,'')),lower(?))>0 OR instr(lower(COALESCE(payload,'')),lower(?))>0)"); const text = boundedText(q.query, "search", 500); params.push(text, text, text); }
        const db = store.database;
        const predicate = conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
        const result = db.query(`SELECT seq, at, type, summary, id FROM frames WHERE seq < ?${predicate} ORDER BY seq DESC LIMIT ?`).all(before, ...params, limit + 1) as any[];
        const frames = result.slice(0, limit).map(f => ({ ...f, id: f.id ?? undefined }));
        const total = (db.query(`SELECT COUNT(*) AS n FROM frames WHERE 1${predicate}`).get(...params) as { n: number }).n;
        const types = (db.query("SELECT DISTINCT type FROM frames ORDER BY type").all() as { type: string }[]).map(r => r.type);
        return { frames, total, types, nextBefore: result.length > limit ? frames.at(-1)!.seq : null };
      }
      default: throw new Error("Unknown Endograph operation");
    }
  } finally { store.close(); }
}
