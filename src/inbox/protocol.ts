import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorldPatch } from "../world/model.ts";

/**
 * The wire: one JSON file per message, written to a temp name and renamed
 * atomically into <home>/agent/inbox/. Replies go to
 * <home>/agent/outbox/<incident>.json. Any process that can write a file
 * is a client. `from` is stamped by the binding, never trusted from a
 * payload the agent did not write; what a client says about itself is
 * `origin`.
 */

export const PROTOCOL_VERSION = 1;

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  incident: string;
  /** Principal: "local:eleven", "ssh:eleven@fox". */
  from: string;
  /** Client-asserted context: a worktree path. */
  origin?: string;
  at: number;
}

/** Prose; the agent decides whether a rule or the model answers. */
export interface RequestMessage extends Envelope {
  kind: "request";
  /** The one structured field: what the request is about (a sha, a path). */
  ref?: string;
  text: string;
  /** A standing session ("capex", "learn") riding the inbox. */
  session?: string;
}

/** A named exposed procedure; the sender asks for the deterministic answer. */
export interface CallMessage extends Envelope {
  kind: "call";
  procedure: string;
  args: Record<string, string>;
}

/** A background job or peer answering on the agent's behalf. */
export interface ReplyMessage extends Envelope {
  kind: "reply";
  ok: boolean;
  text: string;
}

/** A script or peer maintaining the world model: merge top-level keys, remove others. */
export interface WorldMessage extends Envelope, WorldPatch {
  kind: "world";
}

export type InboxMessage = RequestMessage | CallMessage | ReplyMessage | WorldMessage;

/** Lifecycle vocabulary (borrowed from A2A) for the state of an incident. */
export type ReplyState = "completed" | "failed" | "rejected" | "input-required";

export interface Reply {
  v: typeof PROTOCOL_VERSION;
  incident: string;
  ok: boolean;
  state: ReplyState;
  text: string;
  at: number;
}

export function newIncident(): string {
  return `inc-${crypto.randomUUID().slice(0, 8)}`;
}

/** Atomically drop a message file into an inbox directory. */
export function writeMessage(inboxDir: string, message: InboxMessage): void {
  const id = message.kind === "world" ? `world-${crypto.randomUUID().slice(0, 8)}` : message.incident;
  atomicWrite(inboxDir, `${message.at}-${id}.json`, message);
}

export function writeReply(outboxDir: string, reply: Reply): void {
  atomicWrite(outboxDir, `${reply.incident}.json`, reply);
}

export function readReply(outboxDir: string, incident: string): Reply | null {
  try {
    const parsed = JSON.parse(readFileSync(join(outboxDir, `${incident}.json`), "utf8")) as Reply;
    return typeof parsed.incident === "string" && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Block until the reply lands or the timeout passes. */
export async function waitForReply(
  outboxDir: string,
  incident: string,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<Reply | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 1000;
  for (;;) {
    const reply = readReply(outboxDir, incident);
    if (reply) return reply;
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

export function replyState(ok: boolean, refused?: boolean): ReplyState {
  return ok ? "completed" : refused ? "rejected" : "failed";
}

/** The local binding's principal: the calling OS user. */
export function localPrincipal(): string {
  return `local:${process.env.USER ?? process.env.LOGNAME ?? "unknown"}`;
}
