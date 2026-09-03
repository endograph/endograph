import {
  actionResult,
  createAction,
  createCharter,
  createMachine,
  createNode,
  hydrateInstance,
  runMachine,
  type Charter,
  type Instance,
  type ProjectorExecutor,
  type SerializedInstance,
} from "@projectors/core";
import { z } from "zod";
import type { FrameStore } from "../store/types.ts";

/**
 * Hydration recovery, app-owned: when the agent's serialized instance no
 * longer hydrates against the current charter (a procedure it carried was
 * deleted, a state changed shape), a migrator proposes a corrected
 * instance and hydration is tried again — up to MAX_MIGRATIONS times,
 * then a human. The default migrator is the model, run as its own
 * activation on a bootstrap machine over the same store, so every attempt
 * is in the log and metered by provenance.
 */

export const MAX_MIGRATIONS = 5;

export interface MigrationInput {
  serialized: SerializedInstance;
  error: string;
  attempt: number;
  registry: { actions: string[]; states: string[]; nodes: string[] };
  /** Try a proposal: the hydrated instance, or the error it produced. */
  tryHydrate: (proposed: SerializedInstance) => { ok: true; instance: Instance } | { ok: false; error: string };
}

export type Migrator = (input: MigrationInput) => Promise<SerializedInstance>;

export class MigrationFailed extends Error {
  constructor(public attempts: number, public lastError: string) {
    super(`instance did not hydrate after ${attempts} migration(s); a human is needed: ${lastError}`);
  }
}

export function registryOf(charter: Charter): MigrationInput["registry"] {
  return { actions: Object.keys(charter.actions), states: Object.keys(charter.states), nodes: Object.keys(charter.nodes) };
}

/**
 * Guardrail: a proposal may drop what the error names and nothing else.
 * State containers must survive with their values; instance ids must
 * survive; the root stays the root.
 */
export function guardProposal(previous: SerializedInstance, proposed: SerializedInstance, error: string): string | null {
  if (proposed.id !== previous.id) return `the instance id must stay "${previous.id}"`;
  if (!!proposed.isSource !== !!previous.isSource) return "the source flag must not change";
  for (const [key, container] of Object.entries(previous.states ?? {})) {
    if (error.includes(key)) continue;
    const next = proposed.states?.[key];
    if (!next) return `state "${key}" must survive (the error does not name it)`;
    if (JSON.stringify(next.value) !== JSON.stringify(container.value)) return `state "${key}" must keep its value (the error does not name it)`;
  }
  for (const child of previous.children ?? []) {
    if (error.includes(child.id)) continue;
    const next = proposed.children?.find((c) => c.id === child.id);
    if (!next) return `child instance "${child.id}" must survive (the error does not name it)`;
    const problem = guardProposal(child, next, error);
    if (problem) return problem;
  }
  return null;
}

/** The model as migrator: one bootstrap activation, one tool, the real hydrate as the check. */
export function modelMigrator(executor: ProjectorExecutor, store: FrameStore, agentName: string): Migrator {
  return async (input) => {
    let accepted: SerializedInstance | undefined;
    const propose = createAction({
      state: null,
      name: "propose",
      description: "Propose the corrected instance as JSON. It is hydrated against the charter immediately; you get the error if it still fails.",
      inputSchema: z.object({ instance: z.string().describe("The corrected SerializedInstance, JSON-encoded") }),
      run: ({ instance }) => {
        let proposed: SerializedInstance;
        try {
          proposed = JSON.parse(instance) as SerializedInstance;
        } catch (err) {
          return actionResult({ success: false, error: `not JSON: ${err instanceof Error ? err.message : err}` });
        }
        const guard = guardProposal(input.serialized, proposed, input.error);
        if (guard) return actionResult({ success: false, error: `refused: ${guard}` });
        const result = input.tryHydrate(proposed);
        if (!result.ok) return actionResult({ success: false, error: `still does not hydrate: ${result.error}` });
        accepted = proposed;
        return actionResult({ value: "hydrated", terminal: true });
      },
    });
    const node = createNode({
      key: "endo-migrator",
      instructions: [
        `You are migrating the persisted instance of the embedded agent "${agentName}" so it hydrates against its current charter.`,
        `The instance is JSON: a tree of instances, each with a node (a registered key, or an inline node built from registered`,
        `references plus text parts) and state containers. Something it references no longer exists in the charter, or a value`,
        `no longer fits a state's schema. Make the smallest change that lets it hydrate: drop or rename dangling references,`,
        `keep every state value and every child unless the error names it. Registered names you may use:`,
        `actions: ${input.registry.actions.join(", ") || "(none)"}; states: ${input.registry.states.join(", ") || "(none)"}; nodes: ${input.registry.nodes.join(", ") || "(none)"}.`,
        `Call propose with the full corrected instance; repeat if it reports an error. Stop after it says "hydrated".`,
      ].join(" "),
      tools: [propose],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const charter = createCharter({ key: "endo-migration", version: "1", nodes: [node], actions: [propose] });
    const machine = createMachine({ id: `${agentName}:migration`, instance: { id: "migration", isSource: true, node }, charter, executor });
    machine.subscribe((frame) =>
      store.append({
        type: "migration",
        subject: "self",
        summary: frame.messages.some((m) => m.type === "action" && m.kind === "result") ? "migration step" : `migration attempt ${input.attempt}`,
        at: Date.now(),
        payload: frame,
      }),
    );
    machine.enqueueFrame({
      messages: [
        {
          type: "user",
          text: `Attempt ${input.attempt} of ${MAX_MIGRATIONS}.\n\nHydration error:\n${input.error}\n\nInstance:\n${JSON.stringify(input.serialized, null, 2)}`,
          actor: { id: "endo:migration", label: "migration" },
        },
      ],
    });
    for await (const _frame of runMachine(machine)) {
      // drain
    }
    if (!accepted) throw new Error(`the migrator produced no hydratable proposal (attempt ${input.attempt})`);
    return accepted;
  };
}

/** Try to hydrate; on failure ask the migrator, up to MAX_MIGRATIONS times. Returns the instance and whether it was migrated. */
export async function hydrateWithMigration(
  serialized: SerializedInstance,
  charter: Charter,
  migrate: Migrator | undefined,
  onAttempt?: (attempt: number, error: string) => void,
): Promise<{ instance: Instance; migrated: boolean }> {
  const tryHydrate = (candidate: SerializedInstance) => {
    try {
      return { ok: true as const, instance: hydrateInstance(candidate, charter) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };
  let current = serialized;
  let last = tryHydrate(current);
  if (last.ok) return { instance: last.instance, migrated: false };
  if (!migrate) throw new MigrationFailed(0, last.error);
  for (let attempt = 1; attempt <= MAX_MIGRATIONS; attempt++) {
    onAttempt?.(attempt, last.error);
    current = await migrate({ serialized: current, error: last.error, attempt, registry: registryOf(charter), tryHydrate });
    last = tryHydrate(current);
    if (last.ok) return { instance: last.instance, migrated: true };
  }
  throw new MigrationFailed(MAX_MIGRATIONS, last.error);
}
