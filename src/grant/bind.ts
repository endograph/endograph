import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyAction, StateDescriptor } from "@projectors/core";
import { bash } from "../batteries/bash.ts";
import { evolve } from "../batteries/evolve.ts";
import { scheduler } from "../batteries/scheduler.ts";
import type { Paths } from "../harness/paths.ts";
import type { HostClient } from "../host/client.ts";
import { createHostLanguageModel } from "../host/model.ts";
import { loadHostActions } from "../host/provisions.ts";
import { aisdk, type ExecutorSpec } from "./executor.ts";
import { CodexExecutor } from "@endograph/codex-executor";
import type { BATTERY_NAMES, Battery, Grant } from "./grant.ts";

const BATTERIES: Record<(typeof BATTERY_NAMES)[number], () => Battery> = { bash, evolve, scheduler };
export const loadBatteries = (grant: Grant): Battery[] => grant.batteries.map((name) => BATTERIES[name as keyof typeof BATTERIES]());

/** Executable objects owned by one runtime, distinct from the owner's data. */
export interface RuntimeBindings {
  executor: ExecutorSpec;
  batteries: Battery[];
  states: StateDescriptor[];
  hostActions: AnyAction[];
}

/** Called in the worker (or explicitly by an unsandboxed embedding). */
export async function bindRuntime(paths: Paths, grant: Grant, host?: HostClient): Promise<RuntimeBindings> {
  if (grant.sandbox && !host) throw new Error("sandboxed agents must run through endo up or createAgentHost");
  const batteries = loadBatteries(grant);
  const config = grant.executor;
  let executor: ExecutorSpec;
  if ("module" in config) {
    const file = resolve(paths.agentDir, config.module);
    if (!existsSync(file)) throw new Error(`${paths.grant}: executor.module ${config.module} not found at ${file}`);
    const mod = await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`);
    const spec = mod.default as ExecutorSpec | undefined;
    if (!spec || typeof spec.create !== "function") throw new Error(`${paths.grant}: executor.module ${config.module} must export default { create(): ProjectorExecutor }`);
    executor = { ...spec, description: spec.description ?? `module ${config.module}` };
  } else if ("backend" in config) {
    executor = {
      description: `codex ${config.model ?? "default model"}`,
      create: () => new CodexExecutor(async (input, emit, signal) => {
        if (!host) throw new Error("Codex execution requires the trusted host; run endo up");
        return host.model(input, emit, signal);
      }),
    };
  } else {
    const model = host ? createHostLanguageModel(host, { provider: config.provider, modelId: config.model }) : undefined;
    executor = aisdk(config, model);
  }
  return { executor, batteries, states: batteries.flatMap((b) => b.states ?? []), hostActions: await loadHostActions(paths, grant.hostActions, host) };
}
