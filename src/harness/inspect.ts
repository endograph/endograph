import { existsSync } from "node:fs";
import { basename } from "node:path";
import { serviceState } from "../cli/service.ts";
import { hashOf, inceptionStatus, openInception, type InceptionStatus } from "../inception/incept.ts";
import { firstLine } from "./frames.ts";
import { isLocked } from "./lock.ts";
import type { Paths } from "./paths.ts";
import { HOST, readStatus, since, type LoadFailure, type Status } from "./residence.ts";

export interface Inspection {
  name: string;
  status: Partial<Status> | null;
  locked: boolean;
  phase: "active" | "idle" | "starting" | "incepting" | "down";
  /** Why requests cannot currently be served; null for active/idle workers. */
  reason: string | null;
  failure: LoadFailure | null;
  inception: InceptionStatus | null;
  inputError: string | null;
}

/** Shared observations for CLI and observatory. Never loads generated code. */
export async function inspectAgent(paths: Paths, fallbackName = basename(paths.agentDir)): Promise<Inspection> {
  const status = readStatus(paths);
  const name = status?.name ?? fallbackName;
  const locked = isLocked(paths.lock);
  const attempt = openInception(paths);
  const failure = loadFailure(paths, status);
  let inception: InceptionStatus | null = null;
  let inputError: string | null = null;
  try { inception = await inceptionStatus(paths); }
  catch (error) { inputError = error instanceof Error ? error.message : String(error); }
  let phase: Inspection["phase"] = "down";
  let reason: string | null;
  if (status?.host && status.host !== HOST && status.running) {
    reason = `held by ${status.host} (as of ${since(status.at ?? 0)}); \`endo up --adopt\` to run it here`;
  } else if (locked) {
    if (attempt && (status?.incepting === attempt.n || !(status?.at && status.at > Date.parse(attempt.started)))) {
      phase = "incepting";
      reason = `inception ${attempt.n} is running (${attempt.inceptor}, since ${attempt.started}); it serves again when that lands`;
    } else if (status?.running) {
      phase = status.active ? "active" : "idle";
      reason = null;
    } else {
      phase = "starting";
      reason = "the agent is starting";
    }
  } else if (attempt) {
    reason = attempt.inceptor === "manual"
      ? `inception ${attempt.n} is open for a manual session (since ${attempt.started}); \`endo incept --accept\`, then \`endo up\``
      : `inception ${attempt.n} was interrupted (since ${attempt.started}); \`endo incept\` again`;
  } else if (!existsSync(paths.program)) {
    reason = "no program; `endo up` incepts one";
  } else if (failure) {
    reason = `program does not load at ${failure.stage}: ${firstLine(failure.error)} (as of ${since(failure.at)}); \`endo incept\`, then \`endo up\``;
  } else {
    reason = await serviceReason(name);
  }
  return { name, status, locked, phase, reason, failure, inception, inputError };
}

export async function whyNotServing(paths: Paths, name: string): Promise<string | null> {
  return (await inspectAgent(paths, name)).reason;
}

/** A recorded failure applies only while its program is still present and unchanged. */
export function loadFailure(paths: Paths, status = readStatus(paths)): LoadFailure | null {
  const failure = status?.failure;
  if (!failure || typeof failure.stage !== "string" || typeof failure.error !== "string" || typeof failure.program !== "string" || typeof failure.at !== "number") return null;
  try { return hashOf(paths.program) === failure.program ? failure : null; }
  catch { return null; }
}

async function serviceReason(name: string): Promise<string> {
  const svc = await serviceState(name).catch(() => null);
  const supervisor = process.platform === "darwin" ? "launchd" : "systemd";
  if (svc?.loaded) {
    if (svc.pid) return `the service is starting (pid ${svc.pid})`;
    if (svc.lastExit) return `the service crashed (exit ${svc.lastExit}${svc.runs && svc.runs > 1 ? `, ${svc.runs} runs` : ""}) and ${supervisor} keeps restarting it; \`endo logs\``;
    return `the service exited cleanly and stays down; \`endo logs\` says why, \`endo doctor\` checks the program`;
  }
  if (svc?.installed) return `the service unit is installed but ${supervisor} has not loaded it; \`endo up\``;
  return "nothing runs it; `endo up`";
}
