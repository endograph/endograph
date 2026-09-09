import type { StandardSchemaV1 } from "@standard-schema/spec";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSchema, SchemaError } from "@projectors/core";
import { lookup } from "../cli/registry.ts";
import { newId, recipient, PROTOCOL_VERSION, waitForReply, writeMessage, writeReply, type Reply } from "../protocol/wire.ts";

/**
 * `endograph/procedure`: the script-side library. A procedure is a script
 * whose first statement is `await procedure({...})`. At load the harness
 * imports it in describe mode, where `procedure()` throws a sentinel
 * carrying the metadata; at runtime it validates the call's args and
 * returns them. While it runs the script is a peer of its own agent on the
 * wire, asserting `agent:<name>/<procedure>` as its author.
 */

export interface ProcedureOptions<A extends Record<string, StandardSchemaV1>> {
  description: string;
  /** Peers may `endo call` it. */
  expose?: boolean;
  /** One Standard Schema per arg. */
  args?: A;
  /** Battery fields, validated at describe time by the battery that declares them. */
  [field: string]: unknown;
}

export type InferArgs<A extends Record<string, StandardSchemaV1>> = { [K in keyof A]: StandardSchemaV1.InferOutput<A[K]> };

/** What describe mode collects from one script. */
export interface ProcedureMeta {
  description: string;
  expose: boolean;
  /** JSON Schema per arg. */
  args: Record<string, Record<string, unknown>>;
  fields: Record<string, unknown>;
}

/** Thrown by `procedure()` in describe mode; the loader catches it by name. */
export class DescribeSignal extends Error {
  override readonly name = "EndoDescribe";
  constructor(readonly meta: ProcedureMeta) {
    super("describe");
  }
}

export interface Receipt {
  id: string;
  /** The state directory whose outbox answers it: this agent's, or the `to` agent's. */
  state: string;
  /** Notifications have no request/reply lifecycle. */
  notification?: boolean;
}

const env = () => ({
  run: process.env.ENDO_RUN,
  procedure: process.env.ENDO_PROCEDURE,
  agent: process.env.ENDO_AGENT,
  state: process.env.ENDO_STATE,
  args: process.env.ENDO_ARGS,
});

let acked = false;
let installed = false;

export async function procedure<const A extends Record<string, StandardSchemaV1> = {}>(
  options: ProcedureOptions<A>,
): Promise<InferArgs<A>> {
  const { description, expose, args, ...fields } = options;
  const schemas = (args ?? {}) as Record<string, StandardSchemaV1>;
  if (process.env.ENDO_DESCRIBE === "1") {
    const jsonArgs: ProcedureMeta["args"] = {};
    for (const [key, schema] of Object.entries(schemas)) jsonArgs[key] = normalizeSchema(schema).jsonSchema();
    throw new DescribeSignal({ description, expose: expose === true, args: jsonArgs, fields });
  }
  const ctx = env();
  if (!ctx.run || !ctx.state || !ctx.procedure) {
    throw new Error("this script is a procedure: run it through the agent (`endo call`), not directly");
  }
  installExitHooks(ctx.state, ctx.run);
  const given = JSON.parse(ctx.args ?? "{}") as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(given)) if (!(key in schemas)) problems.push(`unknown arg ${key}`);
  for (const [key, schema] of Object.entries(schemas)) {
    try {
      normalizeSchema(schema).assert(given[key]);
    } catch (err) {
      problems.push(`${key}: ${err instanceof SchemaError ? err.message : String(err)}`);
    }
  }
  if (problems.length) {
    console.error(`invalid args: ${problems.join("; ")}`);
    process.exit(2);
  }
  return given as InferArgs<A>;
}

/**
 * End the sync phase early: `text` is the action result the caller gets (a
 * `working` reply on the wire) and the script keeps running.
 */
export function actionResult(text: string): void {
  const ctx = env();
  if (!ctx.run || !ctx.state) throw new Error("actionResult() outside a procedure run");
  if (acked) throw new Error("actionResult() called twice");
  acked = true;
  // The harness commits this acknowledgement before publishing it in the outbox.
  writeReply(join(ctx.state, "runs", "acks"), { v: PROTOCOL_VERSION, id: ctx.run, ok: true, state: "working", text, at: Date.now() });
}

/** Accepted caller context, separate from procedure arguments. */
export function caller(): { from: string; id: string } {
  const from = process.env.ENDO_FROM;
  const id = process.env.ENDO_RUN;
  if (!from || !id) throw new Error("caller() outside a procedure run");
  return { from, id };
}

/** Local agents receive requests; other identities receive durable notifications. */
export function emitMessage(message: { text: string; ref?: string; to?: string }): Receipt {
  const ctx = env();
  if (!ctx.run || !ctx.state || !ctx.agent || !ctx.procedure) throw new Error("emitMessage() outside a procedure run");
  if (!acked) throw new Error("call actionResult() first, or exit without emitting");
  const to = recipient(message.to ?? ctx.agent);
  const local = /^agent:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(to);
  let state = ctx.state;
  let routed = !!local;
  if (local && local[1] !== ctx.agent) {
    const entry = lookup(local[1]!);
    if (entry?.exists) state = join(entry.dir, ".endo");
    else routed = false;
  }
  const id = newId();
  writeMessage(join(state, "inbox"), {
    v: PROTOCOL_VERSION, kind: routed ? "request" : "notification", id,
    from: `agent:${ctx.agent}/${ctx.procedure}`, to, cause: ctx.run,
    text: message.text, ref: message.ref, at: Date.now(),
  });
  return { id, state, ...(!routed ? { notification: true } : {}) };
}

/** The terminal reply to a message this procedure emitted. Rejects on timeout. */
export async function waitForCompletion(receipt: Receipt, opts: { timeoutMs?: number } = {}): Promise<Reply> {
  if (receipt.notification) throw new Error("notifications have no completion reply; a binding must collect them");
  const reply = await waitForReply(join(receipt.state, "outbox"), receipt.id, {
    timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000, pollMs: 250, terminal: true,
  });
  if (!reply) throw new Error(`timed out waiting for a reply to ${receipt.id}`);
  return reply;
}

/** Resolves when the agent has no open requests and no running activation. */
export async function waitForQuiescence(opts: { timeoutMs?: number } = {}): Promise<void> {
  const ctx = env();
  if (!ctx.state) throw new Error("waitForQuiescence() outside a procedure run");
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60 * 1000);
  const status = join(ctx.state, "status.json");
  for (;;) {
    try {
      const s = JSON.parse(readFileSync(status, "utf8")) as { open: string[]; active: boolean };
      if (s.open.length === 0 && !s.active) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error("timed out waiting for quiescence");
    await Bun.sleep(250);
  }
}

/** The exit code lands in runs/<id>.exit; the harness turns it and the captured output into the terminal reply. */
function installExitHooks(state: string, run: string): void {
  if (installed) return;
  installed = true;
  const exitFile = join(state, "runs", `${run}.exit`);
  process.on("exit", (code) => {
    if (!existsSync(exitFile)) writeFileSync(exitFile, String(code));
  });
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    });
  }
}
