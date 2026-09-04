import { actionResult, createAction, createNode, tool, type AnyAction, type Node, type RuntimeTrigger } from "@projectors/core";
import { z } from "zod";
import type { Battery, BatteryContext } from "../grant/grant.ts";

declare module "../program/define.ts" {
  interface GrantedActions {
    transition: AnyAction;
    spawn: AnyAction;
    cede: AnyAction;
  }
}

/**
 * The evolve battery: projector's transition, spawn, and cede as actions.
 * Leave it out and the agent cannot reshape its instance. Include it and
 * the inceptor still chooses which node carries them and what the
 * instructions around them say. A node built at runtime references only
 * registered actions; every reshaping is a frame, with the reason in it.
 */

const NODE = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case"),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
  tools: z.array(z.string()),
  runtime: z.enum(["component", "generator"]).optional(),
  trigger: z.enum(["actor-frame", "primary", "spawn", "parent-activation", "parent-completion"]).optional(),
});
type NodeInput = z.infer<typeof NODE>;

export function evolve(): Battery {
  return {
    name: "evolve",
    guide: GUIDE,
    actions: (ctx) => [
      createAction({
        state: null,
        name: "spawn",
        description:
          "Add a child under the node you run in: a component (its instructions and tools project into your own " +
          "surface) or a generator (its own history; runs on its trigger). tools are names of granted actions or " +
          "procedures. Say why: the reason is recorded with the change.",
        inputSchema: z.object({ node: NODE, reason: z.string().min(1) }),
        run: ({ node, reason }, actionCtx) => {
          const built = build(node, ctx);
          if (typeof built === "string") return actionResult({ success: false, error: built });
          actionCtx.instance.spawn(built);
          return `spawned ${node.key}: ${reason}`;
        },
      }),
      createAction({
        state: null,
        name: "transition",
        description:
          "Replace the node you run in with a new shape: new instructions and tool set, same instance and states. " +
          "Prefer spawn, a state update, or a procedure; a transition is merged by hand at the next inception. " +
          "Say why: the reason is recorded with the change.",
        inputSchema: z.object({ node: NODE, reason: z.string().min(1) }),
        run: ({ node, reason }, actionCtx) => {
          const built = build(node, ctx);
          if (typeof built === "string") return actionResult({ success: false, error: built });
          actionCtx.instance.transition(built);
          return `transitioned to ${node.key}: ${reason}`;
        },
      }),
      createAction({
        state: null,
        name: "cede",
        description:
          "Remove a child you spawned (by its node key), or, with no key, the node you run in. Say why: the reason " +
          "is recorded with the change.",
        inputSchema: z.object({ key: z.string().optional(), reason: z.string().min(1) }),
        run: ({ key, reason }, actionCtx) => {
          if (key) {
            const known = ctx.charter().nodes[key];
            actionCtx.instance.cede(known ?? ({ key } as Node));
            return `ceded ${key}: ${reason}`;
          }
          actionCtx.instance.cede();
          return actionResult({ value: `ceded: ${reason}`, terminal: true });
        },
      }),
    ],
  };
}

/** A node from the model's description, against the charter's registered actions. The error text when a tool is unknown. */
function build(input: NodeInput, ctx: BatteryContext): Node | string {
  const actions = ctx.charter().actions;
  const missing = input.tools.filter((t) => !actions[t]);
  if (missing.length) return `unknown tools: ${missing.join(", ")}; granted: ${Object.keys(actions).join(", ")}`;
  return createNode({
    key: input.key,
    purpose: input.purpose,
    instructions: input.instructions,
    parts: input.tools.map((t) => tool(actions[t]!)),
    runtime: input.runtime === "generator" ? { type: "generator", trigger: { type: input.trigger ?? "actor-frame" } as RuntimeTrigger } : { type: "component" },
  });
}

const GUIDE = `# evolve

Three actions on the running instance: \`spawn({ node, reason })\`,
\`transition({ node, reason })\`, \`cede({ key?, reason })\`. A node is
described, not coded: \`{ key, purpose, instructions, tools, runtime?,
trigger? }\`, where \`tools\` are names of granted actions or procedures
(nothing else exists at runtime), \`runtime\` is \`component\` (default:
projects into the parent's surface, no history of its own) or
\`generator\` (its own history, runs on \`trigger\`, default
\`actor-frame\`). Every reshaping is a frame carrying the reason, so the
next inception reads intent, not mechanics.

Idioms (PROGRAM.md §6.6):

- You decide which node carries these actions and what its instructions
  say about when to use them. A root that can transition itself can also
  erase its own instructions; give it a rule.
- Prefer, in order: a procedure (new behavior), a state update (new
  memory), a spawn (new structure), and only then a transition. The first
  three compose and survive a later inception on their own; a transition
  replaces a node wholesale and is merged by hand next time.
- A spawned generator is a private sub-machine: it sees broadcast
  messages and the states it declares, not the parent's transcript. Put
  what it needs in its instructions or in a state.
- Cede what you spawned when its job is done; a ceded root ends the
  activation.
`;
