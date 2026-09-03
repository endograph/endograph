import { createState, recencyRegion, type AnySchema, type StateDescriptor } from "@projectors/core";
import { z } from "zod";

/**
 * The world model: the agent's converged picture of the domain it tends,
 * projected into every activation, shown by `endo status`, and kept truthful
 * by the model (the world tool), scripts, and peers (world messages).
 *
 * The owner may type it in the declaration. Without a declared schema it is
 * the generic map below: subject → entry. A permissive schema (a loose
 * object, a record) lets the agent add keys the owner did not foresee; a
 * strict one does not. Projector schemas are validation-only, so `init`
 * must be a complete valid value.
 */
export interface WorldSpec {
  schema: AnySchema;
  init: Record<string, unknown>;
  render?: (value: unknown) => string;
}

export const worldEntrySchema = z.object({
  kind: z.string(),
  state: z.enum(["green", "yellow", "red", "gray"]),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  updatedAt: z.number(),
});
export const worldSchema = z.record(z.string(), worldEntrySchema);

export type WorldEntry = z.infer<typeof worldEntrySchema>;
export type WorldModel = z.infer<typeof worldSchema>;

export const WORLD_STATE_KEY = "world";

/** A set of top-level keys to merge and keys to remove: one atomic write. */
export interface WorldPatch {
  set?: Record<string, unknown>;
  clear?: string[];
}

export function applyWorldPatch(current: unknown, patch: WorldPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...((current ?? {}) as Record<string, unknown>), ...(patch.set ?? {}) };
  for (const key of patch.clear ?? []) delete next[key];
  return next;
}

export function isEntryMap(value: unknown): value is WorldModel {
  return worldSchema.safeParse(value).success;
}

export function renderWorld(value: unknown): string {
  if (isEntryMap(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "World model: empty (set entries with the world tool).";
    const lines = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([subject, e]) => {
        const data = Object.keys(e.data).length ? ` ${JSON.stringify(e.data)}` : "";
        return `- ${subject} [${e.state}] ${e.summary}${data} (${new Date(e.updatedAt).toISOString()})`;
      });
    return `World model:\n${lines.join("\n")}`;
  }
  const keys = value && typeof value === "object" ? Object.keys(value as object) : [];
  if (keys.length === 0) return "World model: empty (set keys with the world tool).";
  return `World model:\n${JSON.stringify(value, null, 2)}`;
}

export const defaultWorld: WorldSpec = { schema: worldSchema, init: {}, render: renderWorld };

export function worldStateFor(spec: WorldSpec): StateDescriptor {
  return createState({
    key: WORLD_STATE_KEY,
    schema: spec.schema,
    init: spec.init,
    projection: { slot: recencyRegion, render: spec.render ?? renderWorld },
  });
}
