import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnyAction, AnySchema, Charter, StateDescriptor } from "@projectors/core";
import { z } from "zod";
import type { HostAction } from "../host/action.ts";
import type { Paths } from "../harness/paths.ts";
import type { AiSdkOptions } from "./executor.ts";

/**
 * The grant: owner-written selections of provisions, host actions and
 * process policy. The charter uses its provisions; the outer process
 * enforces sandbox and host-action access independently of agent code.
 */

/** A battery bundles what it contributes. It constrains shape, never behavior. */
export interface Battery {
  name: string;
  /** Markdown the inceptor reads: what the battery offers and the idioms for using it. */
  guide: string;
  states?: StateDescriptor[];
  /** Actions, built at load against the resolved agent context. */
  actions?(agent: BatteryContext): AnyAction[];
  /** Trusted definitions for a host_modules export; only selected names become worker proxies. */
  hostActions?: readonly HostAction[];
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

export interface CodexOptions {
  backend: "codex";
  model?: string;
  command?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  maxToolCalls?: number;
}
export type ExecutorConfig = AiSdkOptions | CodexOptions | { module: string };

/** Validated owner configuration: data only, safe to read in any process. */
export interface Grant {
  name: string;
  /** The owner's intent, in prose: `manifest.md` beside the grant, or inline in it. */
  manifest: { text: string; path?: string };
  executor: ExecutorConfig;
  /** Relative to the agent directory. */
  cwd: string;
  batteries: string[];
  /** Names selected by the owner; binding them requires an explicit host connection. */
  hostActions: string[];
  /** Owner-managed modules exporting host actions; only the outer process imports these. */
  hostModules: string[];
  sandbox?: SandboxPolicy;
  /** `mode`: "auto" (default) incepts by itself, at quiescence, when the owner's inputs changed; "manual" waits for `endo incept`. */
  inception: { inceptor?: string; rounds: number; mode: "auto" | "manual" };
}

export interface SandboxPolicy {
  network: "full" | "offline" | "loopback" | string[];
  /** Additional readable/writable paths, relative to the agent directory. */
  read: string[];
  write: string[];
  /** Extra environment variables forwarded from the trusted parent. */
  env: string[];
}

/** The actions endo always contributes; no battery may reuse their names. */
export const CORE_ACTION_NAMES = ["reply", "compact", "update_state"] as const;

export const BATTERY_NAMES = ["bash", "evolve", "scheduler"] as const;

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SCHEMA = z
  .object({
    name: z.string().regex(NAME, "kebab-case: lowercase words joined by single hyphens"),
    manifest: z.union([z.string(), z.object({ text: z.string().min(1) }).strict()]).optional(),
    cwd: z.string().optional(),
    batteries: z.array(z.string()).optional(),
    host_actions: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)).optional(),
    host_modules: z.array(z.string().min(1)).optional(),
    sandbox: z.object({
      network: z.union([z.enum(["full", "offline", "loopback"]), z.array(z.string().min(1))]).optional(),
      read: z.array(z.string().min(1)).optional(),
      write: z.array(z.string().min(1)).optional(),
      env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    }).strict().optional(),
    executor: z.union([
      z.object({ backend: z.literal("codex"), model: z.string().min(1).optional(), command: z.string().min(1).optional(),
        effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
        max_tool_calls: z.number().int().positive().optional() }).strict(),
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
    inception: z.object({ inceptor: z.string().optional(), rounds: z.number().int().positive().optional(), mode: z.enum(["auto", "manual"]).optional() }).strict().optional(),
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
  const hostNames = config.host_actions ?? [];
  if (new Set(hostNames).size !== hostNames.length) throw new Error(`${paths.grant}: a host action is listed twice`);
  const batteries: string[] = [];
  for (const name of config.batteries ?? []) {
    if (!(BATTERY_NAMES as readonly string[]).includes(name)) throw new Error(`${paths.grant}: unknown battery "${name}"; available: ${BATTERY_NAMES.join(", ")}`);
    if (batteries.includes(name)) throw new Error(`${paths.grant}: battery "${name}" listed twice`);
    batteries.push(name);
  }
  const executor: ExecutorConfig = "module" in config.executor ? { module: config.executor.module } : "backend" in config.executor ? {
    backend: "codex", model: config.executor.model, command: config.executor.command, effort: config.executor.effort, maxToolCalls: config.executor.max_tool_calls,
  } : {
    provider: config.executor.provider,
    model: config.executor.model,
    maxOutputTokens: config.executor.max_output_tokens,
    temperature: config.executor.temperature,
  };
  return {
    name: config.name,
    manifest: manifestOf(paths, config.manifest),
    executor,
    cwd: config.cwd ?? ".",
    batteries,
    hostActions: hostNames,
    hostModules: config.host_modules ?? [],
    sandbox: config.sandbox ? {
      network: config.sandbox.network ?? "offline",
      read: config.sandbox.read ?? [],
      write: config.sandbox.write ?? [],
      env: config.sandbox.env ?? [],
    } : undefined,
    inception: { inceptor: config.inception?.inceptor, rounds: config.inception?.rounds ?? 5, mode: config.inception?.mode ?? "auto" },
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
