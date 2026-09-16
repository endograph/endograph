import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The wire: one JSON file per message, written to a temp name and renamed
 * atomically into `.endo/inbox/`. Replies go to `.endo/outbox/<id>.json` as
 * well as the frame log, so a reader needs no SQLite. Any process that can
 * write a file is a client. Inbox writers are trusted to assert `from`; absent authorship is derived
 * by the binding; what a client asserts about itself is `origin`.
 */

export const PROTOCOL_VERSION = 1;

/** Identity syntax is checked; filesystem writers are trusted to assert it. */
export function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && /^[a-z][a-z0-9+.-]*:[^\s\x00-\x1f\x7f]+$/.test(value);
}

export function recipient(value: string): string {
  const identity = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value) ? `agent:${value}` : value;
  if (!isIdentity(identity)) throw new Error("invalid recipient identity");
  return identity;
}

interface Envelope {
  from?: string;
  to?: string;
  /** The request/run that caused this message; attribution, not delegated authority. */
  cause?: string;
  v: typeof PROTOCOL_VERSION;
  /** Minted by the client. A second message with an id the inbox has seen is dropped. */
  id: string;
  /** Set by `endograph/procedure`: the run emitting this message. The harness resolves it to `agent:<name>/<procedure>`. */
  run?: string;
  /** With `run`: the agent whose run it is, when the message goes to another agent. The receiver checks that agent's live runs. */
  agent?: string;
  /** Client-asserted context (a worktree path). Unverified. */
  origin?: string;
  /** Subject context: what the message is about (a sha, a path, an issue). Follow-ups repeat it. */
  ref?: string;
  /** Persistent discussion identity; independent of sender identity and topic ref. */
  thread?: string;
  at: number;
}

/** Prose. Answered by the model. */
export interface RequestMessage extends Envelope {
  kind: "request";
  text: string;
}

/** A named exposed procedure. Answered by the procedure's replies: an optional `working` ack, then one terminal reply. */
export interface CallMessage extends Envelope {
  kind: "call";
  procedure: string;
  /** Validated against the procedure's arg schemas. */
  args: Record<string, unknown>;
}

/** Addressed output, collected by a binding; never wakes the local model. */
export interface NotificationMessage extends Envelope {
  kind: "notification";
  to: string;
  text: string;
}
export type Message = RequestMessage | CallMessage | NotificationMessage;

/** A message as the harness sees it: `from` supplied by a trusted writer or derived by the binding. */
export type Delivered<M extends Message> = M & {
  /** "local:eleven", "local:uid:502", "timer:nightly", "agent:endofrog/deploy". */
  from: string;
};

/** A2A's lifecycle vocabulary. `working` is a procedure's ack; completed, failed, rejected, and canceled end a request or call. */
export type ReplyState = "submitted" | "working" | "input-required" | "completed" | "failed" | "rejected" | "canceled";

/** Only submitted/working keep a request open; input-required ends this exchange too. */
export function isTerminal(state: ReplyState | undefined): boolean {
  return state !== undefined && state !== "working" && state !== "submitted";
}

export interface Reply {
  from?: string;
  to?: string;
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  state: ReplyState;
  text: string;
  at: number;
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Wire IDs are filenames too; never accept path separators or traversal. */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || typeof m.id !== "string" || !ID.test(m.id) || typeof m.at !== "number" || !Number.isFinite(m.at)) return false;
  for (const key of ["origin", "ref", "run", "agent", "thread"]) if (m[key] !== undefined && typeof m[key] !== "string") return false;
  for (const key of ["from", "to"]) if (m[key] !== undefined && !isIdentity(m[key])) return false;
  if (m.cause !== undefined && (typeof m.cause !== "string" || !ID.test(m.cause))) return false;
  if (m.thread !== undefined && (typeof m.thread !== "string" || !ID.test(m.thread))) return false;
  if (m.kind === "notification") return isIdentity(m.to) && typeof m.text === "string";
  if (m.run !== undefined && !ID.test(m.run as string)) return false;
  if (m.agent !== undefined && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m.agent as string)) return false;
  if (m.kind === "request") return typeof m.text === "string";
  return m.kind === "call" && typeof m.procedure === "string" && !!m.args && typeof m.args === "object" && !Array.isArray(m.args);
}

/** Atomically drop a message file into an inbox directory. */
export function writeMessage(inboxDir: string, message: Message): void {
  if (!isMessage(message)) throw new Error("invalid wire message");
  atomicWrite(inboxDir, `${message.at}-${message.id}.json`, message);
}

export function writeReply(outboxDir: string, reply: Reply): void {
  if (!ID.test(reply.id)) throw new Error("invalid reply id");
  atomicWrite(outboxDir, `${reply.id}.json`, reply);
}

export function readReply(outboxDir: string, id: string): Reply | null {
  if (!ID.test(id)) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(outboxDir, `${id}.json`), "utf8")) as Reply;
    return typeof parsed.id === "string" && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Block until a reply lands (the terminal one, with `terminal`) or the timeout passes. */
export async function waitForReply(
  outboxDir: string,
  id: string,
  opts: { timeoutMs: number; pollMs?: number; terminal?: boolean },
): Promise<Reply | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 1000;
  for (;;) {
    const reply = readReply(outboxDir, id);
    if (reply && (!opts.terminal || isTerminal(reply.state))) return reply;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export function atomicWrite(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o666);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, name));
    const parent = openSync(dir, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    rmSync(tmp, { force: true });
  }
}
