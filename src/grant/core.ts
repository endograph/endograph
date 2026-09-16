import { actionResult, createAction, type AnyAction, type StateUpdate } from "@projectors/core";
import { z } from "zod";
import type { threadStore } from "../store/threads.ts";
import type { ReplyState } from "../protocol/wire.ts";
import type { BatteryContext } from "./grant.ts";
import type { RuntimeBindings } from "./bind.ts";

/**
 * The actions endo always contributes: the one that answers a request, the
 * one that bounds history, and the one that writes memory. Everything else
 * an agent can do comes from a battery, a pass-through action, or a
 * procedure.
 */

/** What `reply` needs from the harness. */
export interface CoreRuntime {
  /** Answer a request or call. Returns an error when the id is unknown or already answered. */
  reply(id: string, reply: { ok: boolean; state: ReplyState; text: string }): string | null;
  /** The JSON Schema of a declared state, so a rejected write can say what would have been accepted. */
  stateSchema?(key: string): Record<string, unknown> | undefined;
  threads?: ReturnType<typeof threadStore>;
}

const REPLY_STATES = ["completed", "failed", "rejected", "input-required", "working"] as const satisfies readonly ReplyState[];

export function coreActions(runtime: CoreRuntime): AnyAction[] {
  const reply = createAction({
    state: null,
    name: "reply",
    description:
      "Answer a request by its id. Every request gets exactly one terminal reply " +
      "(completed, failed, rejected); a second is refused. Use state input-required " +
      "to ask the sender something, and working only when a procedure is carrying " +
      "the work. Omitted, state follows ok.",
    inputSchema: z.object({
      id: z.string(),
      ok: z.boolean(),
      text: z.string(),
      state: z.enum(REPLY_STATES).optional(),
    }),
    run: ({ id, ok, text, state }) => {
      const error = runtime.reply(id, { ok, state: state ?? (ok ? "completed" : "failed"), text });
      return error ? actionResult({ success: false, error }) : `replied to ${id}`;
    },
  });

  const compact = createAction({
    state: null,
    name: "compact",
    description:
      "Record a horizon and summary for your projected history. Older frames remain " +
      "in the log and state values are unchanged. This does not reset a persistent " +
      "executor conversation.",
    inputSchema: z.object({ summary: z.string().min(1) }),
    run: ({ summary }) =>
      actionResult({
        value: "history compacted",
        messages: [
          { type: "horizon", audience: "self" },
          {
            type: "user",
            text: `Summary of everything before this point (older frames are in the log, not in view):\n\n${summary}`,
            actor: { id: "endo:compaction", label: "compaction" },
            audience: "self",
          },
        ],
      }),
  });

  const updateState = createAction({
    state: null,
    name: "update_state",
    description:
      "Write a declared state by key. replace sets the whole value; patch merges " +
      "keys into the object at path (default: the root); append pushes values onto " +
      "the array at path. The write is checked against the state's schema and a " +
      "rejected write changes nothing.",
    inputSchema: z.object({
      state: z.string(),
      op: z.enum(["replace", "patch", "append"]),
      value: z.unknown().optional(),
      values: z.array(z.unknown()).optional(),
      path: z.array(z.union([z.string(), z.number()])).optional(),
    }),
    run: ({ state, op, value, values, path }, ctx) => {
      if (!ctx.updateStateAt) return actionResult({ success: false, error: "state writes are not available here" });
      const update: StateUpdate =
        op === "replace"
          ? { op, value }
          : op === "patch"
            ? { op, value: value as Record<string, unknown>, path }
            : { op, values: values ?? [], path };
      try {
        ctx.updateStateAt(state, update);
      } catch (err) {
        const schema = runtime.stateSchema?.(state);
        const hint = schema ? `\nthe value must satisfy this schema: ${JSON.stringify(schema)}` : "";
        return actionResult({ success: false, error: `${state}: ${err instanceof Error ? err.message : String(err)}${hint}` });
      }
      return `${op} ${state}`;
    },
  });

  const threads = createAction({
    state: null,
    name: "threads",
    description: "Create, read, or update persistent discussion threads. Thread identity groups messages; it does not isolate memory or decide access. Metadata is yours to organize.",
    inputSchema: z.object({ op: z.enum(["list", "get", "create", "update", "messages"]), id: z.string().optional(), title: z.string().optional(), archived: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional(), before: z.number().optional(), limit: z.number().optional() }),
    run: ({ op, id, title, archived, metadata, before, limit }) => {
      if (!runtime.threads) return actionResult({ success: false, error: "Threads are unavailable during program validation" });
      try {
        if (op === "list") return runtime.threads.list();
        if (op === "create") return runtime.threads.create({ id, title, metadata });
        if (!id) throw new Error("Thread ID is required");
        if (op === "get") return runtime.threads.get(id);
        if (op === "messages") return runtime.threads.messages({ threadId: id, before, limit });
        return runtime.threads.update(id, { title, archived, metadata });
      } catch (error) { return actionResult({ success: false, error: error instanceof Error ? error.message : String(error) }); }
    },
  });
  return [reply, compact, updateState, threads];
}

/** Everything the grant puts in the charter: core, then each battery's. Names must not collide. */
export function grantActions(grant: Pick<RuntimeBindings, "batteries" | "hostActions">, ctx: BatteryContext, runtime: CoreRuntime): AnyAction[] {
  const actions = [...coreActions(runtime), ...grant.batteries.flatMap((b) => b.actions?.(ctx) ?? []), ...grant.hostActions];
  const names = new Set<string>();
  for (const a of actions) {
    if (names.has(a.name)) throw new Error(`action "${a.name}" is granted twice`);
    names.add(a.name);
  }
  return actions;
}
