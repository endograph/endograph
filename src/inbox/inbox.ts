import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Drift, Sensor, VerbResult } from "../core/types.ts";
import type { Frame, FrameInput, FrameStore } from "../store/types.ts";
import type { WorldEntry } from "../world/model.ts";
import { endoPayloadOf } from "../world/world.ts";

/**
 * Message passing. Peers (other agents, the owner, a CI job) put requests
 * in the agent's inbox; the inbox sensor turns each poll's batch into ONE
 * drift so a burst of requests is judged once, and every request is
 * answered exactly once — by an explicit `reply`, or automatically with
 * the drift's settlement when nobody replied.
 *
 * Transport is formal (identity, correlation, one dedup key); content is
 * prose. Requests are files so `endo send` never needs the supervisor's
 * process — the frame log stays single-writer.
 */

export interface Request {
  /** Correlation id; the reply carries the same one. */
  incident: string;
  /** Who asked: a path, a hostname, an agent name — identity, not auth. */
  from: string;
  /** The one structured field: what the request is about (a sha, a path). */
  ref?: string;
  text: string;
  at: number;
  /**
   * A standing-session request ("capex"): the agent runs that session's
   * prompt instead of treating the text as an ordinary request.
   */
  session?: string;
}

export interface Reply {
  incident: string;
  ok: boolean;
  text: string;
  at: number;
}

export type RecordFn = (
  input: FrameInput,
  entries?: Record<string, WorldEntry | null>,
) => void;

/** A peer answering a request on the agent's behalf (a background job finishing). */
export interface ReplyMessage {
  kind: "reply";
  incident: string;
  ok: boolean;
  text: string;
  from: string;
  at: number;
}

/** A peer or script maintaining the world model. */
export interface WorldMessage {
  kind: "world";
  op: "set" | "clear";
  subject: string;
  entryKind?: string;
  state?: WorldEntry["state"];
  summary?: string;
  data?: Record<string, unknown>;
  from: string;
  at: number;
}

export type InboxMessage = (Request & { kind?: "request" }) | ReplyMessage | WorldMessage;

export function newIncident(): string {
  return `inc-${crypto.randomUUID().slice(0, 8)}`;
}

/** Atomically drop a message file into an inbox directory. */
export function writeMessage(inboxDir: string, message: InboxMessage): void {
  mkdirSync(inboxDir, { recursive: true });
  const id = message.kind === "world" ? `world-${crypto.randomUUID().slice(0, 8)}` : message.incident;
  const name = `${message.at}-${id}.json`;
  const tmp = join(inboxDir, `.${name}.tmp`);
  Bun.write(tmp, JSON.stringify(message));
  renameSync(tmp, join(inboxDir, name));
}

export function writeRequest(inboxDir: string, request: Request): void {
  writeMessage(inboxDir, { kind: "request", ...request });
}

export function requestSubject(incident: string): string {
  return `request:${incident}`;
}

export class Inbox {
  private dir: string;
  private record: RecordFn;
  private intervalMs: number;
  private pending = new Map<string, Request>();

  constructor(opts: { dir: string; record: RecordFn; intervalMs?: number }) {
    this.dir = opts.dir;
    this.record = opts.record;
    this.intervalMs = opts.intervalMs ?? 1000;
    mkdirSync(this.dir, { recursive: true });
  }

  sensor(): Sensor {
    return {
      name: "inbox",
      intervalMs: this.intervalMs,
      poll: () => this.poll(),
    };
  }

  pendingRequests(): Request[] {
    return [...this.pending.values()];
  }

  /** Answer a request. False when it is unknown or already answered. */
  reply(incident: string, ok: boolean, text: string): boolean {
    if (!this.pending.has(incident)) return false;
    this.pending.delete(incident);
    this.record({
      type: "reply",
      subject: requestSubject(incident),
      summary: `${ok ? "ok" : "failed"}: ${firstLine(text)}`,
      incident,
      payload: { ok, text, to: incident } satisfies Record<string, unknown>,
      at: Date.now(),
    });
    return true;
  }

  async poll(): Promise<Drift[]> {
    const batch = this.drain();
    if (batch.length === 0) return [];
    const first = batch[0]!;
    const froms = [...new Set(batch.map((r) => r.from))];
    return [
      {
        kind: "request.received",
        subject: requestSubject(first.incident),
        summary:
          batch.length === 1
            ? `request from ${first.from}: ${firstLine(first.text)}`
            : `${batch.length} requests pending from ${froms.join(", ")}`,
        data: { requests: batch },
        incident: first.incident,
        observedAt: batch[batch.length - 1]!.at,
        settle: (result) => this.settle(batch, result),
      },
    ];
  }

  /** A peer (typically a background job started by a rule) answering a request. */
  private handleReplyMessage(parsed: Record<string, unknown>, file: string): void {
    const incident = parsed.incident;
    const text = parsed.text;
    if (typeof incident !== "string" || typeof text !== "string") {
      this.record({ type: "error", subject: "inbox", summary: `discarded malformed reply file ${file}`, at: Date.now() });
      return;
    }
    if (!this.reply(incident, parsed.ok !== false, text)) {
      this.record({
        type: "note",
        subject: requestSubject(incident),
        summary: `reply from ${String(parsed.from ?? "peer")} ignored: ${incident} is not awaiting a reply`,
        incident,
        at: Date.now(),
      });
    }
  }

  /** A peer or script maintaining the world model (`endo world set`). */
  private handleWorldMessage(parsed: Record<string, unknown>, file: string): void {
    const subject = parsed.subject;
    if (typeof subject !== "string" || !subject) {
      this.record({ type: "error", subject: "inbox", summary: `discarded malformed world file ${file}`, at: Date.now() });
      return;
    }
    const from = String(parsed.from ?? "peer");
    if (parsed.op === "clear") {
      this.record({ type: "world", subject, summary: `cleared ${subject} (${from})`, at: Date.now() }, { [subject]: null });
      return;
    }
    const state = parsed.state;
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    this.record(
      { type: "world", subject, summary: `${subject}: ${summary || "(updated)"} (${from})`, at: Date.now() },
      {
        [subject]: {
          kind: typeof parsed.entryKind === "string" ? parsed.entryKind : subject.split(":")[0] ?? "entry",
          state: state === "green" || state === "yellow" || state === "red" || state === "gray" ? state : "gray",
          summary,
          data: parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {},
          updatedAt: Date.now(),
        },
      },
    );
  }

  /** Whatever was not explicitly answered gets the drift's settlement. */
  private settle(batch: Request[], result: VerbResult): void {
    // A script's summary is its last stdout line, which the detail tail
    // already ends with — don't say it twice.
    const detail = result.detail?.trimEnd();
    const text = !detail
      ? result.summary
      : detail.endsWith(result.summary)
        ? detail
        : `${result.summary}\n${detail}`;
    for (const request of batch) {
      this.reply(request.incident, result.ok, text);
    }
  }

  private drain(): Request[] {
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .sort();
    } catch {
      return [];
    }
    const batch: Request[] = [];
    for (const file of files) {
      const path = join(this.dir, file);
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // fall through: malformed
      }
      unlinkSync(path);
      const kind = parsed?.kind ?? "request";
      if (kind === "reply" && parsed) {
        this.handleReplyMessage(parsed, file);
        continue;
      }
      if (kind === "world" && parsed) {
        this.handleWorldMessage(parsed, file);
        continue;
      }
      const request = parseRequest(parsed);
      if (!request) {
        this.record({
          type: "error",
          subject: "inbox",
          summary: `discarded malformed inbox file ${file}`,
          at: Date.now(),
        });
        continue;
      }
      this.pending.set(request.incident, request);
      this.record({
        type: "request",
        subject: requestSubject(request.incident),
        summary: `${request.from}${request.ref ? ` (${request.ref})` : ""}: ${firstLine(request.text)}`,
        incident: request.incident,
        payload: request as unknown as Record<string, unknown>,
        at: request.at,
      });
      batch.push(request);
    }
    return batch;
  }
}

/** Find the reply to a request in a frame log, if it has arrived. */
export function findReply(store: FrameStore, incident: string, fromSeq = 0): Reply | null {
  let from = fromSeq;
  for (;;) {
    const frames = store.read(from, 1000);
    if (frames.length === 0) return null;
    for (const frame of frames) {
      const reply = replyOf(frame);
      if (reply && reply.incident === incident) return reply;
    }
    from = frames[frames.length - 1]!.seq;
  }
}

export function replyOf(frame: Frame): Reply | null {
  if (frame.type !== "reply" || !frame.incident) return null;
  const payload = endoPayloadOf(frame);
  return {
    incident: frame.incident,
    ok: payload?.ok === true,
    text: typeof payload?.text === "string" ? payload.text : frame.summary,
    at: frame.at,
  };
}

/** Block until the reply lands or the timeout passes. */
export async function waitForReply(
  store: FrameStore,
  incident: string,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<Reply | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 1000;
  for (;;) {
    const reply = findReply(store, incident);
    if (reply) return reply;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

function parseRequest(parsed: Record<string, unknown> | undefined): Request | undefined {
  if (
    !parsed ||
    typeof parsed.incident !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.text !== "string"
  ) {
    return undefined;
  }
  return {
    incident: parsed.incident,
    from: parsed.from,
    ref: typeof parsed.ref === "string" ? parsed.ref : undefined,
    text: parsed.text,
    at: typeof parsed.at === "number" ? parsed.at : Date.now(),
    ...(typeof parsed.session === "string" ? { session: parsed.session } : {}),
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 200);
}
