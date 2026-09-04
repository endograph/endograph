/**
 * endograph: embedded agents on projector. Everything a grant, a program,
 * or a procedure imports comes from here (projector's primitives, and zod
 * for schemas), so one copy of each is in play and an agent directory
 * needs no dependencies of its own.
 */
export { defineAgent, type AgentConfig, type Battery, type BatteryContext, type Grant, type TickContext } from "./grant/define.ts";
export { aisdk, type AiSdkOptions, type ExecutorSpec } from "./grant/executor.ts";
export { bash } from "./batteries/bash.ts";
export { evolve } from "./batteries/evolve.ts";
export { scheduler } from "./batteries/scheduler.ts";
export { defineProgram, type Program, type ProgramResult, type Provisions } from "./program/define.ts";
export {
  action,
  command,
  createAction,
  createComputedPart,
  createHistoryProjectionFunction,
  createLayout,
  createNode,
  createSlot,
  createSourceInstance,
  createState,
  include,
  text,
  tool,
} from "@projectors/core";
export { z } from "zod";
