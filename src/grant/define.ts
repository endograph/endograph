import type { AnyAction, AnySchema, Charter, StateDescriptor } from "@projectors/core";
import type { ExecutorSpec } from "./executor.ts";

/**
 * The grant: `endograph.ts` exports `defineAgent({...})`. It is the whole
 * universe of what the agent may ever do: every action the model can call
 * (core, battery, pass-through), every grant-provided state, the executor.
 * Owner-written, typechecked, never reachable from the program.
 */

/** A battery bundles what it contributes. It constrains shape, never behavior. */
export interface Battery {
  name: string;
  /** Markdown the inceptor reads: what the battery offers and the idioms for using it. */
  guide: string;
  states?: StateDescriptor[];
  /** Actions, built at load against the resolved agent context. */
  actions?(agent: BatteryContext): AnyAction[];
  /** Extra `procedure()` fields: a schema per field, and a describe-time check over the values a script gave. */
  procedure?: {
    fields: Record<string, { schema: AnySchema; description: string }>;
    validate?(values: Record<string, unknown>, procedure: string): string | null;
  };
  hooks?: {
    /** Every 30 s while the agent runs. */
    tick?(now: number, ctx: TickContext): void | Promise<void>;
  };
}

/** What a battery's actions are built with. */
export interface BatteryContext {
  name: string;
  /** Absolute: where procedures and bash run. */
  cwd: string;
  /** The assembled charter, once the agent is loaded; throws before that. */
  charter(): Charter;
}

/** What a tick sees: the described procedures, and a way to call one as a timer. */
export interface TickContext {
  procedures: { name: string; fields: Record<string, unknown> }[];
  /** Start an exposed-or-not procedure with `from = timer:<name>`; the call and its replies are frames. */
  call(procedure: string, args: Record<string, unknown>): void;
}

export interface AgentConfig {
  /** Required; kebab-case. The registry key, the unit label, `from` on outgoing messages. */
  name: string;
  /** Relative to the agent directory. Default `./manifest.md`. */
  manifest?: string;
  executor: ExecutorSpec;
  /** Relative to the agent directory. Default `.`. */
  cwd?: string;
  batteries?: Battery[];
  /** Pass-through projector states. */
  states?: StateDescriptor[];
  /** Pass-through projector actions. */
  actions?: AnyAction[];
  inception?: {
    /** The inceptor command; default: the first of claude, codex on PATH. */
    inceptor?: string;
    /** Validation rounds before an inception gives up. Default 5. */
    rounds?: number;
  };
}

export interface Grant {
  name: string;
  manifest: string;
  executor: ExecutorSpec;
  cwd: string;
  batteries: Battery[];
  states: StateDescriptor[];
  actions: AnyAction[];
  inception: { inceptor?: string; rounds: number };
}

/** The actions endo always contributes; nothing in the grant may reuse their names. */
export const CORE_ACTION_NAMES = ["reply", "compact", "update_state"] as const;

const BRAND = Symbol.for("endograph.grant");
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Resolves to `never` unless S is kebab-case, so a bad name fails to typecheck. */
type KebabCase<S extends string> = S extends Lowercase<S>
  ? S extends `${string}${" " | "_" | "." | "/" | ":" | "--"}${string}` | `-${string}` | `${string}-` | ""
    ? never
    : S
  : never;

export function defineAgent<const N extends string>(config: Omit<AgentConfig, "name"> & { name: N & KebabCase<N> }): Grant {
  if (!NAME.test(config.name)) throw new Error(`agent name "${config.name}" must be kebab-case (${NAME})`);
  const batteries = config.batteries ?? [];
  const seen = new Set<string>();
  for (const b of batteries) {
    if (seen.has(b.name)) throw new Error(`battery "${b.name}" granted twice`);
    seen.add(b.name);
  }
  const actions = config.actions ?? [];
  for (const a of actions) {
    if ((CORE_ACTION_NAMES as readonly string[]).includes(a.name)) throw new Error(`action "${a.name}" is a core action`);
  }
  const keys = new Set<string>();
  for (const s of [...batteries.flatMap((b) => b.states ?? []), ...(config.states ?? [])]) {
    if (keys.has(s.key)) throw new Error(`state "${s.key}" granted twice`);
    keys.add(s.key);
  }
  return {
    [BRAND]: true,
    name: config.name,
    manifest: config.manifest ?? "./manifest.md",
    executor: config.executor,
    cwd: config.cwd ?? ".",
    batteries,
    states: [...batteries.flatMap((b) => b.states ?? []), ...(config.states ?? [])],
    actions,
    inception: { inceptor: config.inception?.inceptor, rounds: config.inception?.rounds ?? 5 },
  } as Grant;
}

export function isGrant(value: unknown): value is Grant {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}
