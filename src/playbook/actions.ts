import { actionResult, createAction, type AnyAction } from "@projectors/core";
import { z } from "zod";
import type { Outcome } from "../loop/types.ts";
import { runProcedure, type ScriptContext } from "./run.ts";
import type { PlaybookEntry, Procedure } from "./types.ts";

/**
 * Procedures compile to projector actions: the model sees `deploy(WORKTREE)`
 * as a typed tool, and an exposed procedure is the same action reachable by
 * peers as a command (`executeCommand`). The action's value is the script's
 * Outcome, so both callers read one shape.
 */
export function procedureAction(procedure: Procedure, scripts: () => ScriptContext): AnyAction {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(procedure.args)) {
    const s = z.string().describe(spec.description ?? key);
    shape[key] = spec.required ? s : s.optional();
  }
  return createAction({
    state: null,
    name: procedure.name,
    description: `${procedure.description ?? `procedure ${procedure.name}`}${procedure.expose ? " (exposed to peers)" : ""} — runs in the working directory; returns {ok, summary, detail}.`,
    inputSchema: z.object(shape).strict(),
    run: async (input) => {
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) if (typeof v === "string") args[k] = v;
      const outcome: Outcome = await runProcedure(procedure, args, scripts());
      // Refusals and in-progress are decisions, not failures; the value carries the whole outcome either way.
      return outcome.ok || outcome.pending || outcome.refused
        ? actionResult({ value: outcome })
        : actionResult({ success: false, error: outcome.summary, value: outcome });
    },
  });
}

/** A stable fingerprint of the procedure surface; a change means the charter must be rebuilt. */
export function procedureSignature(entries: PlaybookEntry[]): string {
  return entries
    .filter((e): e is Procedure => e.kind === "procedure")
    .map((p) => `${p.name}${p.expose ? "!" : ""}(${Object.entries(p.args).map(([k, s]) => `${k}${s.required ? "" : "?"}`).join(",")})${p.description ?? ""}`)
    .join("|");
}
