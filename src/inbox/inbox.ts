import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Drift, Outcome, Sensor } from "../loop/types.ts";
import { openIncidents } from "../store/queries.ts";
import type { FrameInput, FrameStore } from "../store/types.ts";
import type { WorldPatch } from "../world/model.ts";
import {
  replyState,
  writeReply,
  type CallMessage,
  type InboxMessage,
  type ReplyState,
  type RequestMessage,
  PROTOCOL_VERSION,
} from "./protocol.ts";

/**
 * The inbox sensor drains a poll's batch. Requests become ONE drift so a
 * burst is judged once; every request is answered exactly once — by an
 * explicit reply, or with the drift's settlement. Calls run their exposed
 * procedure without waking the model. Reply and world messages act on the
 * agent's behalf. A request naming a session is not a drift: it starts
 * that session and is answered with its outcome.
 */

export type RecordFn = (input: Omit<FrameInput, "at"> & { at?: number }, patch?: WorldPatch) => void;

export interface InboxOptions {
  inboxDir: string;
  outboxDir: string;
  record: RecordFn;
  /** Run an exposed procedure for a call; the inbox replies with the outcome. */
  onCall: (call: CallMessage) => Promise<Outcome>;
  /** Run a standing session on a peer's request; the inbox replies with the outcome. */
  onSession: (name: string, ask: string | undefined) => Promise<Outcome>;
  intervalMs?: number;
}

export function requestSubject(incident: string): string {
  return `request:${incident}`;
}

export class Inbox {
  private pending = new Map<string, RequestMessage | CallMessage>();
  /** Calls run one at a time: two deploys at once is never what anyone meant. */
  private calls: Promise<unknown> = Promise.resolve();

  constructor(private opts: InboxOptions) {}

  /**
   * On start: anything consumed from the inbox before a restart but never
   * answered is answered now, honestly. The sender is blocked on `wait`.
   */
  recoverOpen(store: FrameStore): number {
    const open = openIncidents(store);
    for (const frame of open) {
      const incident = frame.incident!;
      writeReply(this.opts.outboxDir, {
        v: PROTOCOL_VERSION,
        incident,
        ok: false,
        state: "failed",
        text: "the agent restarted before answering this; send it again",
        at: Date.now(),
      });
      this.opts.record({
        type: "reply",
        subject: requestSubject(incident),
        summary: `failed: restarted before answering (${frame.type} from ${frame.summary.split(":")[0]})`,
        incident,
        payload: { ok: false, state: "failed", to: incident, recovered: true },
      });
    }
    return open.length;
  }

  sensor(): Sensor {
    return { name: "inbox", intervalMs: this.opts.intervalMs ?? 1000, poll: () => this.poll() };
  }

  pendingMessages(): (RequestMessage | CallMessage)[] {
    return [...this.pending.values()];
  }

  /** Answer an incident. False when it is unknown or already answered. */
  reply(incident: string, ok: boolean, text: string, opts: { refused?: boolean; state?: ReplyState } = {}): boolean {
    if (!this.pending.has(incident)) return false;
    this.pending.delete(incident);
    const state = opts.state ?? replyState(ok, opts.refused);
    const at = Date.now();
    writeReply(this.opts.outboxDir, { v: PROTOCOL_VERSION, incident, ok, state, text, at });
    this.opts.record({
      type: "reply",
      subject: requestSubject(incident),
      summary: `${state}: ${firstLine(text)}`,
      incident,
      payload: { ok, state, text, to: incident },
      at,
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
        // Every request's text, so a rule's regex sees a batch the same way
        // it sees a single request. A batch is settled as one.
        detail: batch.map((r) => `${r.incident} ${r.from}: ${r.text}`).join("\n"),
        data: { requests: batch },
        incident: first.incident,
        observedAt: batch[batch.length - 1]!.at,
        settle: (outcome) => this.settle(batch, outcome),
      },
    ];
  }

  /** Whatever was not explicitly answered gets the drift's settlement. */
  private settle(batch: RequestMessage[], outcome: Outcome): void {
    const detail = outcome.detail?.trimEnd();
    const text = !detail ? outcome.summary : detail.endsWith(outcome.summary) ? detail : `${outcome.summary}\n${detail}`;
    for (const request of batch) this.reply(request.incident, outcome.ok, text, { refused: outcome.refused });
  }

  private handleCall(call: CallMessage): void {
    this.pending.set(call.incident, call);
    const args = Object.entries(call.args).map(([k, v]) => `${k}=${v}`).join(" ");
    this.opts.record({
      type: "call",
      subject: requestSubject(call.incident),
      summary: `${call.from}: ${call.procedure}${args ? ` ${args}` : ""}`,
      incident: call.incident,
      payload: call,
      at: call.at,
    });
    // Not awaited: a call may run for minutes and must not block the poll.
    // Serialized: calls run one after another.
    const run = () => this.opts.onCall(call);
    const next = this.calls.then(run, run);
    this.calls = next.catch(() => {});
    void next
      .then((outcome) => {
        this.opts.record({
          type: "outcome",
          subject: requestSubject(call.incident),
          summary: `${call.procedure}: ${outcome.refused ? "refused — " : outcome.pending ? "in progress — " : ""}${outcome.summary}`,
          incident: call.incident,
          payload: { procedure: call.procedure, ok: outcome.ok, refused: outcome.refused ?? false, pending: outcome.pending ?? false, detail: outcome.detail },
          at: Date.now(),
        });
        if (outcome.pending) return; // a job answers later with `endo reply`
        const text = outcome.detail?.trimEnd() || outcome.summary;
        this.reply(call.incident, outcome.ok, text, { refused: outcome.refused });
      })
      .catch((err) => this.reply(call.incident, false, `call failed: ${err instanceof Error ? err.message : err}`));
  }

  private handleSession(request: RequestMessage): void {
    const name = request.session!;
    this.pending.set(request.incident, request);
    void this.opts
      .onSession(name, request.text.trim() || undefined)
      .then((outcome) => this.reply(request.incident, outcome.ok, outcome.summary))
      .catch((err) => this.reply(request.incident, false, `${name} session failed: ${err instanceof Error ? err.message : err}`));
  }

  private handleReply(message: { incident: string; ok?: boolean; text: string; from: string }): void {
    if (!this.reply(message.incident, message.ok !== false, message.text)) {
      this.opts.record({
        type: "note",
        subject: requestSubject(message.incident),
        summary: `reply from ${message.from} ignored: ${message.incident} is not awaiting a reply`,
        incident: message.incident,
      });
    }
  }

  private handleWorld(m: Extract<InboxMessage, { kind: "world" }>): void {
    const set = Object.keys(m.set ?? {});
    const clear = m.clear ?? [];
    const what = [set.length ? `set ${set.join(", ")}` : "", clear.length ? `cleared ${clear.join(", ")}` : ""].filter(Boolean).join("; ");
    try {
      this.opts.record({ type: "world", subject: [...set, ...clear][0], summary: `${what} (${m.from})` }, { set: m.set, clear: m.clear });
    } catch (err) {
      // The machine validated the result against the world schema and refused it.
      this.opts.record({ type: "error", subject: "world", summary: `world message from ${m.from} rejected: ${err instanceof Error ? err.message : err}` });
    }
  }

  private drain(): RequestMessage[] {
    let files: string[];
    try {
      files = readdirSync(this.opts.inboxDir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
    } catch {
      return [];
    }
    const batch: RequestMessage[] = [];
    for (const file of files) {
      const path = join(this.opts.inboxDir, file);
      let message: InboxMessage | undefined;
      let owner: number | undefined;
      try {
        owner = statSync(path).uid;
        message = parseMessage(JSON.parse(readFileSync(path, "utf8")));
      } catch {}
      unlinkSync(path);
      // The file's owner is the kernel's word on who wrote it. Our own uid may
      // claim any local: or ssh: principal (it could forge the file anyway);
      // another uid is named by number, whatever the payload says.
      if (message && owner !== undefined && owner !== process.getuid?.()) message.from = `local:uid:${owner}`;
      if (!message) {
        this.opts.record({ type: "error", subject: "inbox", summary: `discarded malformed inbox file ${file}` });
        continue;
      }
      switch (message.kind) {
        case "request":
          this.opts.record({
            type: "request",
            subject: requestSubject(message.incident),
            summary: `${message.from}${message.ref ? ` (${message.ref})` : ""}: ${message.session ? `${message.session} session` : ""}${message.session && message.text ? " — " : ""}${firstLine(message.text)}`,
            incident: message.incident,
            payload: message,
            at: message.at,
          });
          if (message.session) {
            this.handleSession(message);
            break;
          }
          this.pending.set(message.incident, message);
          batch.push(message);
          break;
        case "call":
          this.handleCall(message);
          break;
        case "reply":
          this.handleReply(message);
          break;
        case "world":
          this.handleWorld(message);
          break;
      }
    }
    return batch;
  }
}

function parseMessage(raw: unknown): InboxMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const kind = m.kind ?? "request";
  const from = typeof m.from === "string" ? m.from : "unknown";
  const at = typeof m.at === "number" ? m.at : Date.now();
  const base = { v: PROTOCOL_VERSION as 1, from, at, origin: typeof m.origin === "string" ? m.origin : undefined };
  if (kind === "world") {
    const set = m.set && typeof m.set === "object" && !Array.isArray(m.set) ? (m.set as Record<string, unknown>) : undefined;
    const clear = Array.isArray(m.clear) ? m.clear.map(String) : undefined;
    if (!set && !clear) return undefined;
    return { ...base, kind: "world", incident: typeof m.incident === "string" ? m.incident : "", set, clear };
  }
  if (typeof m.incident !== "string") return undefined;
  if (kind === "reply" && typeof m.text === "string") {
    return { ...base, kind: "reply", incident: m.incident, ok: m.ok !== false, text: m.text };
  }
  if (kind === "call" && typeof m.procedure === "string") {
    const args: Record<string, string> = {};
    if (m.args && typeof m.args === "object") {
      for (const [k, v] of Object.entries(m.args as Record<string, unknown>)) args[k] = String(v);
    }
    return { ...base, kind: "call", incident: m.incident, procedure: m.procedure, args };
  }
  if (kind === "request" && typeof m.text === "string") {
    return {
      ...base,
      kind: "request",
      incident: m.incident,
      ref: typeof m.ref === "string" ? m.ref : undefined,
      text: m.text,
      session: typeof m.session === "string" ? m.session : undefined,
    };
  }
  return undefined;
}

export function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 200);
}
