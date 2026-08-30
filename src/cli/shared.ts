import type { AgentDir } from "../agent/dir.ts";
import { buildJudgeActions } from "../judge/actions.ts";
import { JudgeRuntime } from "../judge/runtime.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import type { Frame, FrameStore } from "../store/types.ts";
import { openWorld, type World } from "../world/world.ts";

import { endoPayloadOf } from "../world/world.ts";

export { endoPayloadOf as endoPayload };

/**
 * Read-only open for status/query commands. The snapshot references the
 * judge's tools by name, so hydration needs the same tool registry the
 * running agent has — inert here (no executor, never invoked).
 */
export function openAgentWorld(dir: AgentDir): { store: FrameStore; world: World } {
  const store = openSqliteStore(dir.dbPath);
  const world = openWorld(store, {
    machineId: dir.name,
    tools: buildJudgeActions(new JudgeRuntime(), { supervises: true }),
  });
  return { store, world };
}

/**
 * Liveness comes from the log: the last supervisor start/stop marker,
 * cross-checked against the pid actually being alive.
 */
export function supervisorAlive(store: FrameStore, closeAfter = false): boolean {
  const frames = allFrames(store);
  if (closeAfter) store.close();
  const marker = [...frames]
    .reverse()
    .find((f) => f.type === "note" && typeof endoPayloadOf(f)?.supervisor === "string");
  const payload = marker
    ? (endoPayloadOf(marker) as { supervisor: string; pid: number })
    : undefined;
  return payload?.supervisor === "start" && payload.pid != null && pidAlive(payload.pid);
}

export function supervisorMarker(frames: Frame[]): { pid: number; at: number } | undefined {
  const marker = [...frames]
    .reverse()
    .find((f) => f.type === "note" && typeof endoPayloadOf(f)?.supervisor === "string");
  const payload = marker
    ? (endoPayloadOf(marker) as { supervisor: string; pid: number })
    : undefined;
  if (payload?.supervisor === "start" && payload.pid != null && pidAlive(payload.pid)) {
    return { pid: payload.pid, at: marker!.at };
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function allFrames(store: FrameStore): Frame[] {
  const frames: Frame[] = [];
  let from = 0;
  for (;;) {
    const batch = store.read(from, 1000);
    if (batch.length === 0) return frames;
    frames.push(...batch);
    from = batch[batch.length - 1]!.seq;
  }
}

const COLORS: Record<string, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const RESET = "\x1b[0m";

export function dot(state: string): string {
  return `${COLORS[state] ?? ""}●${RESET}`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}${RESET}`;
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour12: false });
}

export function printFrame(frame: Frame): void {
  const subject = frame.subject ? ` ${frame.subject}` : "";
  const incident = frame.incident ? dim(` (${frame.incident})`) : "";
  console.log(
    `${dim(fmtTime(frame.at))} ${frame.type.padEnd(10)}${subject.padEnd(18)} ${frame.summary}${incident}`,
  );
}
