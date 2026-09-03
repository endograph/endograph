import { actionResult, createAction, normalizeSchema, replaceState, SchemaError, schemaFromJsonSchema, type AnyAction, type StateDescriptor } from "@projectors/core";
import { z } from "zod";
import type { LateBound, RuntimeContext } from "../agent/runtime.ts";
import { applyWorldPatch, type WorldSpec } from "../world/model.ts";

/**
 * Tools every agent has: the world model, compaction, and the two
 * terminals that end an activation. Batteries add the rest.
 */
export function coreTools(runtime: LateBound<RuntimeContext>, world: { state: StateDescriptor; spec: WorldSpec }): AnyAction[] {
  const compact = createAction({
    state: null,
    name: "compact",
    description:
      "Replace your visible history with a summary of it. Everything before " +
      "stays in the frame log (endo why/replay), but your next activation " +
      "sees only this summary plus frames after it. Write what a successor " +
      "needs and cannot get elsewhere: what you tend and its current state, " +
      "what peers ask and how you handle it, open requests and unfinished " +
      "work, lessons and pitfalls. Do NOT restate your mandate, tools, or " +
      "playbook — those are always present. Takes effect when this activation ends.",
    inputSchema: z.object({ summary: z.string().min(1) }),
    run: ({ summary }) => {
      runtime.get().requestCompaction(summary);
      return "compaction queued; it applies when this activation ends";
    },
  });

  const resolve = createAction({
    state: null,
    name: "resolve",
    description:
      "End the activation: the matter is handled (or benign). Give the " +
      "diagnosis and what was done. Call exactly one of resolve/escalate.",
    inputSchema: z.object({ diagnosis: z.string(), action_taken: z.string() }),
    run: ({ diagnosis, action_taken }) =>
      actionResult({ value: `resolved: ${diagnosis} — ${action_taken}`, terminal: true }),
  });

  const escalate = createAction({
    state: null,
    name: "escalate",
    description:
      "End the activation: a human is needed. Summarize the situation, " +
      "what you tried, and what you recommend. Call exactly one of resolve/escalate.",
    inputSchema: z.object({ summary: z.string(), recommendation: z.string().optional() }),
    run: ({ summary, recommendation }) =>
      actionResult({ value: `escalate: ${summary}${recommendation ? ` — recommend: ${recommendation}` : ""}`, terminal: true }),
  });

  return [worldTool(world.state, world.spec), compact, resolve, escalate];
}

/**
 * The world tool is generated from the declared world schema: `set` takes
 * the schema's own properties (none required) with whatever it says about
 * additional keys, `clear` removes top-level keys. Bound to the world state,
 * so the write goes through projector's validate-and-enqueue path and a
 * value the schema rejects never lands.
 */
export function worldTool(state: StateDescriptor, spec: WorldSpec): AnyAction {
  const { $schema: _dialect, required: _required, ...setDoc } = normalizeSchema(spec.schema).jsonSchema();
  const inputSchema = schemaFromJsonSchema<{ set?: Record<string, unknown>; clear?: string[] }>({
    type: "object",
    properties: {
      set: { ...setDoc, description: "Top-level keys to merge into the world model" },
      clear: { type: "array", items: { type: "string" }, description: "Top-level keys to remove" },
    },
    additionalProperties: false,
  });
  return createAction({
    state,
    name: "world",
    description:
      "Maintain your world model — the converged picture of what you tend. " +
      "It is projected into every activation and shown by `endo status`; " +
      "scripts and peers can update it too. `set` merges top-level keys, " +
      "`clear` removes them; the write is rejected if the result violates " +
      `the world schema: ${JSON.stringify(setDoc)}`,
    inputSchema,
    run: (input, ctx) => {
      if (!ctx.updateState) return actionResult({ success: false, error: "world state is not bound" });
      const set = Object.keys(input.set ?? {});
      const clear = input.clear ?? [];
      if (set.length === 0 && clear.length === 0) return actionResult({ success: false, error: "nothing to set or clear" });
      try {
        ctx.updateState((current: unknown) => replaceState(applyWorldPatch(current, input)));
      } catch (err) {
        if (err instanceof SchemaError) return actionResult({ success: false, error: `rejected by the world schema: ${err.message}` });
        throw err;
      }
      return [set.length ? `set ${set.join(", ")}` : "", clear.length ? `cleared ${clear.join(", ")}` : ""].filter(Boolean).join("; ");
    },
  });
}
