import type {
  AnyAction,
  AnyComputedPartDef,
  AnyDiscriminator,
  HistoryProjectionFunction,
  Instance,
  LayoutDef,
  Node,
  StateDescriptor,
} from "@projectors/core";

/**
 * The program contract: `.endo/program/agent.ts` exports
 * `defineProgram((endo) => ...)`, a pure function of the provisions
 * returning projector nodes and the initial instance. The return type has
 * no actions, no states registry, no executor: that is the boundary.
 */

/**
 * The actions a program can name statically. Core actions are always
 * here; a battery adds its own by declaration merging. At runtime the
 * object only holds what the grant granted, and naming anything else
 * fails the load at the invoke stage with the granted names.
 */
export interface GrantedActions {
  reply: AnyAction;
  compact: AnyAction;
  update_state: AnyAction;
}

/** What the program receives: the grant, narrowed. */
export interface Provisions {
  name: string;
  cwd: string;
  executorConfig?: Record<string, unknown>;
  /** Every grant action by name: core, battery, pass-through. */
  actions: GrantedActions & Record<string, AnyAction>;
  /** Grant-provided states by key. */
  states: Record<string, StateDescriptor>;
  /** The compiled actions for every procedure, current as of this load. */
  procedures: AnyAction[];
}

export interface ProgramResult {
  nodes: Node[];
  instance: Instance;
  layouts?: LayoutDef[];
  computedParts?: AnyComputedPartDef[];
  discriminators?: AnyDiscriminator[];
  historyProjections?: HistoryProjectionFunction[];
}

export type ProgramFunction = (endo: Provisions) => ProgramResult;

export interface Program {
  build: ProgramFunction;
}

const BRAND = Symbol.for("endograph.program");

export function defineProgram(build: ProgramFunction): Program {
  return { [BRAND]: true, build } as Program;
}

export function isProgram(value: unknown): value is Program {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}
