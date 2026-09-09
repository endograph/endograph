/**
 * endograph: embedded agents on projector. Everything a program or a
 * procedure imports comes from here (projector's primitives, and zod for
 * schemas), so one copy of each is in play and an agent directory needs
 * no dependencies of its own. The grant is data (endograph.toml) and
 * imports nothing.
 */
export type { Battery, BatteryContext, Grant, TickContext } from "./grant/grant.ts";
export type { ExecutorSpec } from "./grant/executor.ts";
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
export { hostAction, HostActionError, type HostAction, type HostActionContext, type JsonValue } from "./host/action.ts";
export { createAgentHost, type AgentHost } from "./host/agent.ts";
