import { z } from "zod";

/**
 * The world model: a typed, converged picture of the owned domain, keyed by
 * subject id (e.g. "process:metro"). The shape is adapter-agnostic — an
 * entry's `kind` and `data` carry the domain specifics.
 */
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
