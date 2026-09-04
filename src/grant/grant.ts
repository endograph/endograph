import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyAction, AnySchema, Charter, StateDescriptor } from "@projectors/core";
import { z } from "zod";
import { bash } from "../batteries/bash.ts";
import { evolve } from "../batteries/evolve.ts";
import { scheduler } from "../batteries/scheduler.ts";
import type { Paths } from "../harness/paths.ts";
import { aisdk, type ExecutorSpec } from "./executor.ts";

/**
 * The grant: `endograph.toml`, the whole universe of what the agent may
 * ever do. Data, not code: a name, an executor, batteries by name,
 * inception options. Owner-written, validated at load, never reachable
 * from the program.
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
  /** Start a procedure with `from = timer:<name>`; the call and its replies are frames. */
  call(procedure: string, args: Record<string, unknown>): void;
}

export interface Grant {
  name: string;
  /** The owner's intent, in prose: `manifest.md` beside the grant, or inline in it. */
  manifest: { text: string; path?: string };
  executor: ExecutorSpec;
  /** Relative to the agent directory. */
  cwd: string;
  batteries: Battery[];
  /** The batteries' states. */
  states: StateDescriptor[];
  inception: { inceptor?: string; rounds: number };
}

/** The actions endo always contributes; no battery may reuse their names. */
export const CORE_ACTION_NAMES = ["reply", "compact", "update_state"] as const;

export const BUILTIN_BATTERIES: Record<string, () => Battery> = { bash, evolve, scheduler };

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SCHEMA = z
  .object({
    name: z.string().regex(NAME, "kebab-case: lowercase words joined by single hyphens"),
    manifest: z.union([z.string(), z.object({ text: z.string().min(1) }).strict()]).optional(),
    cwd: z.string().optional(),
    batteries: z.array(z.string()).optional(),
    executor: z.union([
      z
        .object({
          provider: z.enum(["anthropic", "openai"]),
          model: z.string(),
          max_output_tokens: z.number().int().positive().optional(),
          temperature: z.number().optional(),
        })
        .strict(),
      z.object({ module: z.string() }).strict(),
    ]),
    inception: z.object({ inceptor: z.string().optional(), rounds: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict();

/** Read, parse, validate, and resolve `endograph.toml`. Throws with the file and the reason. */
export async function loadGrant(paths: Paths): Promise<Grant> {
  if (!existsSync(paths.grant)) throw new Error(`no grant at ${paths.grant}`);
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(readFileSync(paths.grant, "utf8"));
  } catch (err) {
    throw new Error(`${paths.grant}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${paths.grant}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  const batteries: Battery[] = [];
  for (const name of config.batteries ?? []) {
    const make = BUILTIN_BATTERIES[name];
    if (!make) throw new Error(`${paths.grant}: unknown battery "${name}"; available: ${Object.keys(BUILTIN_BATTERIES).join(", ")}`);
    if (batteries.some((b) => b.name === name)) throw new Error(`${paths.grant}: battery "${name}" listed twice`);
    batteries.push(make());
  }
  const executor = "module" in config.executor ? await executorModule(paths, config.executor.module) : aisdk({
    provider: config.executor.provider,
    model: config.executor.model,
    maxOutputTokens: config.executor.max_output_tokens,
    temperature: config.executor.temperature,
  });
  return {
    name: config.name,
    manifest: manifestOf(paths, config.manifest),
    executor,
    cwd: config.cwd ?? ".",
    batteries,
    states: batteries.flatMap((b) => b.states ?? []),
    inception: { inceptor: config.inception?.inceptor, rounds: config.inception?.rounds ?? 5 },
  };
}

/** `manifest.md` beside the grant (or the path given), or the text given inline under `[manifest]`. */
function manifestOf(paths: Paths, manifest: string | { text: string } | undefined): Grant["manifest"] {
  // TOML trims the newline after an opening """; Bun's parser does not.
  if (typeof manifest === "object") return { text: manifest.text.replace(/^\r?\n/, "") };
  const path = resolve(paths.agentDir, manifest ?? "manifest.md");
  if (!existsSync(path)) {
    throw new Error(manifest ? `${paths.grant}: manifest ${manifest} not found at ${path}` : `no manifest: write ${path}, or put it inline in ${paths.grant} as [manifest] text = """..."""`);
  }
  return { text: readFileSync(path, "utf8"), path };
}

/** The escape hatch: a TS module (relative to the agent directory) whose default export is an ExecutorSpec. */
async function executorModule(paths: Paths, module: string): Promise<ExecutorSpec> {
  const file = resolve(paths.agentDir, module);
  if (!existsSync(file)) throw new Error(`${paths.grant}: executor.module ${module} not found at ${file}`);
  const mod = (await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`)) as { default?: unknown };
  const spec = mod.default as ExecutorSpec | undefined;
  if (!spec || typeof spec.create !== "function") throw new Error(`${paths.grant}: executor.module ${module} must export default { create(): ProjectorExecutor }`);
  return { ...spec, description: spec.description ?? `module ${module}` };
}
