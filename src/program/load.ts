import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createCharter,
  createMachine,
  hydrateInstance,
  resolveStates,
  type AnyAction,
  type Charter,
  type Frame as ProjectorFrame,
  type Instance,
  type Machine,
  type ProjectorExecutor,
  type SerializedInstance,
  type StateDescriptor,
} from "@projectors/core";
import type { Grant } from "../grant/grant.ts";
import type { RuntimeBindings } from "../grant/bind.ts";
import type { Paths } from "../harness/paths.ts";
import { compileProcedure, describeProcedures, type DescribeFailure, type ProcedureSpec } from "../procedures/describe.ts";
import type { RunStarter } from "../procedures/runs.ts";
import { allFrames, type FrameStore } from "../store/types.ts";
import { isProgram, type Program, type ProgramResult, type Provisions } from "./define.ts";

/**
 * The load pipeline: import the program, describe procedures, invoke the
 * program against the provisions, assemble the charter, hydrate the
 * snapshot, restore its conversation history, replay the frames after it.
 * Every `up` and every procedure change runs it. A failure names its stage.
 */

export type Stage = "program" | "invoke" | "charter" | "hydrate" | "replay";

export class LoadError extends Error {
  constructor(
    readonly stage: Stage,
    message: string,
  ) {
    super(`${stage}: ${message}`);
    this.name = "LoadError";
  }
}

export interface LoadInput {
  paths: Paths;
  grant: Grant;
  bindings: RuntimeBindings;
  store: FrameStore;
  /** Absent for a dry load (inception validation, `endo replay`): the machine hydrates but cannot run. */
  executor?: ProjectorExecutor;
  /** Core, battery, and pass-through actions, already built. */
  actions: AnyAction[];
  /** Absolute. */
  cwd: string;
  startRun: RunStarter;
  /** Hydrate this instead of the store's snapshot (an inception's edited instance.json). */
  instance?: SerializedInstance;
}

export interface Loaded {
  program: Program;
  procedures: (ProcedureSpec & { action: AnyAction })[];
  failures: DescribeFailure[];
  provisions: Provisions;
  result: ProgramResult;
  charter: Charter;
  machine: Machine;
  /** The last store seq folded into the machine. */
  replayedTo: number;
}

export async function loadAgent(input: LoadInput): Promise<Loaded> {
  const { paths, grant, bindings, store } = input;
  const program = await stage("program", async () => {
    const path = realpathSync(paths.program);
    const mod = (await import(`${pathToFileURL(path).href}?t=${statSync(path).mtimeMs}`)) as { default?: unknown };
    if (!isProgram(mod.default)) throw new Error(`${paths.program} must export default defineProgram(...)`);
    return mod.default;
  });

  const described = await describeProcedures(paths.procedures, bindings.batteries);
  const procedures = described.procedures.map((spec) => ({ ...spec, action: compileProcedure(spec, input.startRun) }));

  const provisions: Provisions = {
    name: grant.name,
    cwd: input.cwd,
    executorConfig: bindings.executor.executorConfig,
    actions: granted(input.actions),
    states: Object.fromEntries(bindings.states.map((s) => [s.key, s])),
    procedures: procedures.map((p) => p.action),
  };

  const result = await stage("invoke", () => {
    const r = program.build(provisions);
    if (!r || !Array.isArray(r.nodes) || !r.instance) throw new Error("the program must return { nodes, instance }");
    return r;
  });

  const charter = await stage("charter", () =>
    createCharter({
      key: grant.name,
      nodes: result.nodes,
      actions: [...input.actions, ...provisions.procedures],
      states: liftStates(bindings.states, result),
      ...(result.layouts ? { layouts: result.layouts } : {}),
      ...(result.computedParts ? { computedParts: result.computedParts } : {}),
      ...(result.discriminators ? { discriminators: result.discriminators } : {}),
      ...(result.historyProjections ? { historyProjections: result.historyProjections } : {}),
    }),
  );

  const snapshot = store.readSnapshot();
  const persisted = input.instance ?? (snapshot?.state as SerializedInstance | undefined);
  const instance = await stage("hydrate", () => {
    const i: Instance = persisted ? hydrateInstance(persisted, charter) : result.instance;
    resolveStates(i);
    return i;
  });
  let replayedTo = snapshot?.asOfSeq ?? 0;
  const history = await stage("replay", () => {
    const frames: ProjectorFrame[] = [];
    for (const stored of allFrames(store)) {
      if (stored.seq > replayedTo) break;
      const payload = stored.payload as ProjectorFrame | undefined;
      if (payload && Array.isArray(payload.messages)) frames.push(payload);
    }
    return frames;
  });
  // A snapshot replaces state replay, not history. Passing prior frames as
  // history preserves messages and compaction horizons without reapplying
  // their state/instance mutations against the hydrated (or migrated) instance.
  const machine = createMachine({ id: grant.name, instance, charter, executor: input.executor, frames: history });

  await stage("replay", () => {
    for (const stored of allFrames(store, replayedTo)) {
      replayedTo = stored.seq;
      const payload = stored.payload as ProjectorFrame | undefined;
      if (!payload || !Array.isArray(payload.messages)) continue;
      try {
        machine.enqueueFrame(payload);
      } catch (err) {
        throw new Error(`frame ${stored.seq} (${stored.type}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return { program, procedures, failures: described.failures, provisions, result, charter, machine, replayedTo };
}

/** Actions by name; naming one the grant does not hold throws, so the invoke stage reports it. */
function granted(actions: AnyAction[]): Provisions["actions"] {
  const byName = Object.fromEntries(actions.map((a) => [a.name, a]));
  return new Proxy(byName, {
    get(target, name) {
      if (typeof name !== "string" || name in target) return Reflect.get(target, name);
      throw new Error(`no granted action "${name}"; granted: ${Object.keys(target).join(", ")}`);
    },
  }) as Provisions["actions"];
}

/** Every node's states join the grant's in the charter registry, one descriptor per key. */
function liftStates(granted: StateDescriptor[], result: ProgramResult): StateDescriptor[] {
  const byKey = new Map<string, StateDescriptor>(granted.map((s) => [s.key, s]));
  const visit = (node: { key: string; states: StateDescriptor[]; memberEntries: unknown[] }) => {
    for (const s of node.states) {
      const existing = byKey.get(s.key);
      if (existing && existing !== s) throw new Error(`state "${s.key}" is declared twice with different descriptors (node "${node.key}")`);
      byKey.set(s.key, s);
    }
    for (const m of node.memberEntries) if (m && typeof m === "object" && "states" in m) visit(m as never);
  };
  for (const node of result.nodes) visit(node);
  return [...byKey.values()];
}

async function stage<T>(name: Stage, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new LoadError(name, err instanceof Error ? err.message : String(err));
  }
}
