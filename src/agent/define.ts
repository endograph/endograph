import { normalizeSchema, SchemaError, type AnyAction, type AnySchema, type Node, type ProjectorExecutor, type StateDescriptor } from "@projectors/core";
import type { ActivationOutcome } from "../judge/activate.ts";
import { BIND, inlineActions, SELF_NODE_KEY, type Bindable } from "../judge/evolve.ts";
import { coreTools } from "../judge/tools.ts";
import type { Drift, Outcome, Sensor } from "../loop/types.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { FrameStore } from "../store/types.ts";
import { defaultWorld, worldStateFor, type WorldSpec } from "../world/model.ts";
import type { HomePaths } from "./home.ts";
import { LateBound, type RuntimeContext } from "./runtime.ts";

/**
 * A battery bundles what it contributes: projector states and actions
 * (which become the charter), and the runtime-facing halves (sensors,
 * hooks, commands, status). Constructed at declaration load; bound once
 * the runtime exists.
 */
export interface Battery {
  name: string;
  /** Projected into the model's context. */
  states?: StateDescriptor[];
  /** The model's tools. */
  tools?: AnyAction[];
  sensors?: Sensor[];
  /**
   * Standing sessions by name: self-initiated activations (`endo <name>`,
   * or a battery calling `ctx.session(name)`). The prompt is the opening
   * text; batteries never share labels, only the session's name.
   */
  sessions?: Record<string, Session>;
  hooks?: {
    /** After every activation, with usage summed across steps. */
    afterActivation?(outcome: ActivationOutcome): void | Promise<void>;
    onSettle?(drift: Drift, outcome: Outcome): void;
    /** Roughly once a minute while running (day rollover, quiet-time sessions). */
    tick?(now: number): void | Promise<void>;
  };
  /** Extra `endo <name>` commands. */
  commands?: CliCommand[];
  status?(): StatusLine[];
  bind?(ctx: RuntimeContext): void;
}

export interface Session {
  description: string;
  prompt(ask: string | undefined, ctx: RuntimeContext): string;
}

/** What a CLI command gets: read access, no running agent. */
export interface CommandContext {
  name: string;
  home: HomePaths;
  store: FrameStore;
  playbook: PlaybookEntry[];
}

export interface CliCommand {
  name: string;
  description: string;
  run(args: string[], ctx: CommandContext): Promise<number>;
}

export interface StatusLine {
  subject: string;
  state: "green" | "yellow" | "red" | "gray";
  summary: string;
}

/** Model access: how to build the executor, plus what the meter needs to know. */
export interface ExecutorSpec {
  create(): ProjectorExecutor;
  /** Model id as the executor reports it; prices key off it. */
  model?: string;
  /** USD per million tokens, for models the meter does not know. */
  price?: { input: number; output: number };
  /** Per-node executor config, namespaced by executor identity ({ aisdk: { maxOutputTokens } }). */
  executorConfig?: Record<string, unknown>;
}

export interface AgentConfig {
  /** Required. The registry key, the unit label, `from` on outgoing messages. */
  name: string;
  /** Path to the prose mandate, relative to the declaration directory. */
  mandate?: string;
  /** Where scripts and bash run, relative to the declaration directory. Default ".". */
  cwd?: string;
  executor?: ExecutorSpec | ProjectorExecutor;
  /**
   * The world model's schema (any Standard Schema over an object), or a
   * spec with `init` and `render`. Omit for the generic subject → entry
   * map. A permissive schema (loose object, record) lets the agent add keys;
   * a strict one does not. `init` must be a complete valid value.
   */
  world?: AnySchema | WorldSpec;
  /**
   * Nodes instantiated under the root: components project their parts into
   * the agent's activations; generators run on their own triggers.
   * `evolvable()` is the agent's self — declare it and the agent can
   * reshape itself. Their inline actions are registered in the charter.
   */
  children?: Node[];
  batteries?: Battery[];
  /** Pass-through additions to the charter beyond what batteries contribute. */
  tools?: AnyAction[];
  states?: StateDescriptor[];
}

const BRAND = Symbol.for("endograph.agent");

export interface AgentDefinition {
  readonly [BRAND]: true;
  name: string;
  mandate: string;
  cwd: string;
  executor?: ExecutorSpec;
  world: WorldSpec;
  batteries: Battery[];
  /** Everything the root node carries: core tools, then batteries, then pass-through. */
  states: StateDescriptor[];
  tools: AnyAction[];
  /** Declared root-level children, and the actions their parts carry (charter-registered). */
  children: Node[];
  childActions: AnyAction[];
  /** The self (`evolvable()`) is declared: the agent can reshape itself. */
  evolvable: boolean;
  sessions: Record<string, Session>;
  /** Bind core tools and every battery to the runtime. */
  bind(ctx: RuntimeContext): void;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function defineAgent(config: AgentConfig): AgentDefinition {
  if (!NAME.test(config.name)) {
    throw new Error(`agent name "${config.name}" must be kebab-case (${NAME})`);
  }
  const batteries = config.batteries ?? [];
  const names = new Set<string>();
  for (const b of batteries) {
    if (names.has(b.name)) throw new Error(`battery "${b.name}" registered twice`);
    names.add(b.name);
  }
  const runtime = new LateBound<RuntimeContext>();
  const world = worldSpecOf(config.world);
  const worldState = worldStateFor(world);
  const states = [worldState, ...batteries.flatMap((b) => b.states ?? []), ...(config.states ?? [])];
  const tools = [...coreTools(runtime, { state: worldState, spec: world }), ...batteries.flatMap((b) => b.tools ?? []), ...(config.tools ?? [])];
  const children = config.children ?? [];
  const childKeys = new Set<string>();
  for (const c of children) {
    if (childKeys.has(c.key)) throw new Error(`child node "${c.key}" declared twice`);
    childKeys.add(c.key);
  }
  const childActions = children.flatMap(inlineActions);
  const toolNames = new Set<string>();
  for (const t of [...tools, ...childActions]) {
    if (toolNames.has(t.name)) throw new Error(`tool "${t.name}" registered twice`);
    toolNames.add(t.name);
  }
  const sessions: Record<string, Session> = {};
  for (const b of batteries) {
    for (const [name, session] of Object.entries(b.sessions ?? {})) {
      if (sessions[name]) throw new Error(`session "${name}" registered twice`);
      sessions[name] = session;
    }
  }
  return {
    [BRAND]: true,
    name: config.name,
    mandate: config.mandate ?? "./mandate.md",
    cwd: config.cwd ?? ".",
    executor: config.executor ? toSpec(config.executor) : undefined,
    world,
    batteries,
    states,
    tools,
    children,
    childActions,
    evolvable: childKeys.has(SELF_NODE_KEY),
    sessions,
    bind(ctx) {
      runtime.bind(ctx);
      for (const b of batteries) b.bind?.(ctx);
      for (const a of childActions) (a as Bindable)[BIND]?.(ctx);
    },
  };
}

function worldSpecOf(world: AgentConfig["world"]): WorldSpec {
  if (!world) return defaultWorld;
  const spec: WorldSpec = "~standard" in world ? { schema: world, init: {} } : world;
  try {
    normalizeSchema(spec.schema).assert(spec.init);
  } catch (err) {
    if (err instanceof SchemaError) throw new Error(`world init does not satisfy the world schema: ${err.message}`);
    throw err;
  }
  return spec;
}

function toSpec(executor: ExecutorSpec | ProjectorExecutor): ExecutorSpec {
  return "create" in executor && typeof executor.create === "function"
    ? (executor as ExecutorSpec)
    : { create: () => executor as ProjectorExecutor, model: (executor as ProjectorExecutor).identity?.name };
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}
