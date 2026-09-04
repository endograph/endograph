import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The wire: one JSON file per message, written to a temp name and renamed
 * atomically into `.endo/inbox/`. Replies go to `.endo/outbox/<id>.json` as
 * well as the frame log, so a reader needs no SQLite. Any process that can
 * write a file is a client. `from` is stamped by the binding, never trusted
 * from the payload; what a client asserts about itself is `origin`.
 */

export const PROTOCOL_VERSION = 1;

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  /** Minted by the client. A second message with an id the inbox has seen is dropped. */
  id: string;
  /** Set by `endograph/procedure`: the run emitting this message. The harness resolves it to `agent:<name>/<procedure>`. */
  run?: string;
  /** Client-asserted context (a worktree path). Unverified. */
  origin?: string;
  /** The thread key: what the message is about (a sha, a path, an issue). Follow-ups repeat it. */
  ref?: string;
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

export type Message = RequestMessage | CallMessage;

/** A message as the harness sees it: `from` stamped by the binding, never read from the file. */
export type Delivered<M extends Message> = M & {
  /** "local:eleven", "local:uid:502", "timer:nightly", "agent:endofrog/deploy". */
  from: string;
};

/** A2A's lifecycle vocabulary. `working` is a procedure's ack; completed, failed, rejected, and canceled end a request or call. */
export type ReplyState = "submitted" | "working" | "input-required" | "completed" | "failed" | "rejected" | "canceled";

export interface Reply {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  state: ReplyState;
  text: string;
  at: number;
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Atomically drop a message file into an inbox directory. */
export function writeMessage(inboxDir: string, message: Message): void {
  atomicWrite(inboxDir, `${message.at}-${message.id}.json`, message);
}

export function writeReply(outboxDir: string, reply: Reply): void {
  atomicWrite(outboxDir, `${reply.id}.json`, reply);
}

export function readReply(outboxDir: string, id: string): Reply | null {
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
    if (reply && (!opts.terminal || (reply.state !== "working" && reply.state !== "submitted"))) return reply;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

function atomicWrite(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, join(dir, name));
}
