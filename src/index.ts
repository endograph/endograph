/**
 * endograph — embedded agents on projector.
 *
 * A declaration (`endograph.ts`) exports `defineAgent({...})`; batteries
 * contribute states, tools, sensors, hooks, and commands. Everything a
 * declaration needs is exported from here so one copy of projector and one
 * copy of zod are in play.
 */
export { defineAgent, type AgentConfig, type AgentDefinition, type Battery, type CliCommand, type CommandContext, type ExecutorSpec, type StatusLine } from "./agent/define.ts";
export type { RuntimeContext } from "./agent/runtime.ts";
export { LateBound } from "./agent/runtime.ts";
export { aisdk, type AiSdkOptions } from "./judge/executor.ts";
export { evolvable } from "./judge/evolve.ts";
export { bash } from "./batteries/bash.ts";
export { inbox } from "./batteries/inbox.ts";
export { playbook } from "./batteries/playbook.ts";
export { budget, type BudgetOptions } from "./batteries/budget.ts";
export type { Drift, Sensor, Outcome } from "./loop/types.ts";
export type { Frame, FrameInput, FrameStore } from "./store/types.ts";
export type { Migrator, MigrationInput } from "./world/migrate.ts";
export type { WorldEntry, WorldModel, WorldPatch, WorldSpec } from "./world/model.ts";
export { actionResult, createAction, createNode, createState, recencyRegion, text, tool, type AnyAction, type AnySchema, type Node, type ProjectorExecutor, type StateDescriptor } from "@projectors/core";
export { z } from "zod";
