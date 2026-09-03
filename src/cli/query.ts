import { latestState } from "../store/queries.ts";
import type { Frame, FrameStore } from "../store/types.ts";
import { WORLD_STATE_KEY } from "../world/world.ts";

export { framesAbout, framesOfIncident, openIncidents, recentFrames } from "../store/queries.ts";

export function worldModel(store: FrameStore): Record<string, unknown> {
  return latestState<Record<string, unknown>>(store, WORLD_STATE_KEY) ?? {};
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtFrame(frame: Frame): string {
  const subject = frame.subject ? ` ${frame.subject}` : "";
  const incident = frame.incident ? ` [${frame.incident}]` : "";
  return `${fmtTime(frame.at)} ${frame.type.padEnd(10)}${subject}${incident}  ${frame.summary.split("\n")[0]}`;
}

export const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
