import { actionResult, createAction, createNode, text, tool, walkAllParts, type AnyAction, type Node, type StateDescriptor } from "@projectors/core";
import { z } from "zod";
import { LateBound, type RuntimeContext } from "../agent/runtime.ts";

/**
 * Structural evolution. The root generator is the owner's: mandate, tools,
 * states — fixed. Its child component, the "self", is the agent's: its
 * standing notes and the registered tools it chooses to carry project
 * upward into every activation. These tools live on the self and act on
 * it: transition replaces it, spawn adds children under it, cede removes
 * one. A node the agent builds can only reference actions the charter
 * registered — new behavior enters only through the playbook.
 */

export const SELF_NODE_KEY = "endo-self";
export const EVOLUTION_TOOL_NAMES = ["transition", "spawn", "cede"] as const;

/**
 * Actions contributed by a declared child node may carry a bind hook;
 * `defineAgent` calls it with the runtime once wiring completes. This is
 * how a node built outside `defineAgent` (like `evolvable()`) reaches the
 * runtime its tools need.
 */
export const BIND = Symbol.for("endograph.bind");
export type Bindable = { [BIND]?: (ctx: RuntimeContext) => void };

/** Every action object contributed by a node's parts (the ones a charter must register). */
export function inlineActions(node: Node): AnyAction[] {
  const found: AnyAction[] = [];
  walkAllParts(node.parts, (part) => {
    if (part.kind === "action" && typeof part.action !== "string") found.push(part.action as AnyAction);
  });
  return found;
}

/**
 * The agent's self: declare it under the root (`children: [evolvable()]`)
 * and the agent can reshape itself; leave it out and it cannot. The node
 * carries the evolution tools inline so the charter registers them; a
 * transitioned self references them by name.
 */
export function evolvable(): Node {
  const runtime = new LateBound<RuntimeContext>();
  const tools = evolutionTools(runtime);
  for (const action of tools) (action as Bindable)[BIND] = (ctx) => runtime.bind(ctx);
  return createNode({ key: SELF_NODE_KEY, runtime: { type: "component" }, parts: tools.map((a) => tool(a)) });
}

export interface SelfShape {
  notes?: string;
  tools?: string[];
}

/**
 * The self component: notes, chosen tools, and always the evolution tools.
 * A state-bound tool must be declared alongside its state; the state is a
 * registered descriptor (hoist scope), so it resolves to the root's
 * container and serializes as a ref.
 */
export function selfNode(shape: SelfShape, stateOf: (toolName: string) => StateDescriptor | null | undefined = () => undefined): Node {
  const chosen = (shape.tools ?? []).filter((name) => !(EVOLUTION_TOOL_NAMES as readonly string[]).includes(name));
  const states = new Map<string, StateDescriptor>();
  for (const name of chosen) {
    const state = stateOf(name);
    if (state) states.set(state.key, state);
  }
  return createNode({
    key: SELF_NODE_KEY,
    runtime: { type: "component" },
    states: [...states.values()],
    parts: [
      ...(shape.notes?.trim() ? [text(`# Notes to self\n\n${shape.notes.trim()}`)] : []),
      ...chosen.map((name) => tool(name)),
      ...EVOLUTION_TOOL_NAMES.map((name) => tool(name)),
    ],
  });
}

export type HelperRun = "once" | "with-parent" | "after-parent";

/** A child: a component that extends the self, or a generator that works on its own. */
export function childNode(
  spec: { key: string; kind: "component" | "helper"; instructions?: string; tools?: string[]; run?: HelperRun },
  stateOf: (toolName: string) => StateDescriptor | null | undefined = () => undefined,
): Node {
  const parts = (spec.tools ?? []).map((name) => tool(name));
  const states = new Map<string, StateDescriptor>();
  for (const name of spec.tools ?? []) {
    const state = stateOf(name);
    if (state) states.set(state.key, state);
  }
  if (spec.kind === "component") {
    return createNode({ key: spec.key, runtime: { type: "component" }, states: [...states.values()], parts: [...(spec.instructions ? [text(spec.instructions)] : []), ...parts] });
  }
  const trigger = spec.run === "once" || spec.run === undefined ? { type: "spawn" as const } : spec.run === "after-parent" ? { type: "parent-completion" as const } : { type: "parent-activation" as const };
  return createNode({ key: spec.key, instructions: spec.instructions, runtime: { type: "generator", trigger }, states: [...states.values()], parts });
}

export function evolutionTools(runtime: LateBound<RuntimeContext>): AnyAction[] {
  const known = () => Object.keys(runtime.get().world.charter.actions).filter((n) => !(EVOLUTION_TOOL_NAMES as readonly string[]).includes(n));
  const stateOf = (name: string) => runtime.get().world.charter.actions[name]?.state;
  const unknownTools = (names: string[] | undefined) => (names ?? []).filter((n) => !known().includes(n));

  const transition = createAction({
    state: null,
    name: "transition",
    description:
      "Reshape yourself. Replaces your self node — standing notes projected " +
      "into every activation, and the tools you carry — with the given " +
      "shape. Only registered tools (your procedures and built-ins) can be " +
      "named; new behavior comes from write_procedure. Takes effect on your " +
      "next activation. Children you spawned are kept.",
    inputSchema: z.object({
      notes: z.string().optional().describe("Standing notes to yourself; replaces the previous notes"),
      tools: z.array(z.string()).optional().describe("Registered tool names to carry; omit to carry none beyond the built-ins"),
    }),
    run: (shape, ctx) => {
      const bad = unknownTools(shape.tools);
      if (bad.length) return actionResult({ success: false, error: `unknown tools: ${bad.join(", ")}; known: ${known().join(", ")}` });
      ctx.instance.transition(selfNode(shape, stateOf));
      return `self reshaped: ${shape.tools?.length ?? 0} tool(s), notes ${shape.notes?.trim() ? `${shape.notes.trim().length} chars` : "none"} — applies next activation`;
    },
  });

  const spawn = createAction({
    state: null,
    name: "spawn",
    description:
      "Spawn a child under yourself. kind=component: a bundle of instructions " +
      "and tools that projects into your own activations (cede it later as a " +
      "unit). kind=helper: a generator with its own activations — run=once " +
      "(now, one activation), with-parent (whenever you activate), " +
      "after-parent (after each of your activations). Helpers use your " +
      "executor and budget; their frames are in your log.",
    inputSchema: z.object({
      name: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case"),
      kind: z.enum(["component", "helper"]),
      instructions: z.string().optional(),
      tools: z.array(z.string()).optional(),
      run: z.enum(["once", "with-parent", "after-parent"]).optional(),
    }),
    run: (spec, ctx) => {
      const bad = unknownTools(spec.tools);
      if (bad.length) return actionResult({ success: false, error: `unknown tools: ${bad.join(", ")}; known: ${known().join(", ")}` });
      const key = `${spec.kind}-${spec.name}`;
      ctx.instance.spawn(childNode({ key, kind: spec.kind, instructions: spec.instructions, tools: spec.tools, run: spec.run }, stateOf));
      return `spawned ${key}${spec.kind === "helper" ? ` (runs ${spec.run ?? "once"})` : ""}; cede it with cede(key="${key}")`;
    },
  });

  const cede = createAction({
    state: null,
    name: "cede",
    description: "Remove a child you spawned, by the key spawn returned (component-<name> or helper-<name>).",
    inputSchema: z.object({ key: z.string() }),
    run: ({ key }, ctx) => {
      ctx.instance.cede(createNode({ key, runtime: { type: "component" } }));
      return `ceded ${key} (if it existed)`;
    },
  });

  return [transition, spawn, cede];
}
