import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { openSqliteStore } from "../store/sqlite.ts";
import type { Paths } from "./paths.ts";

/**
 * Where the agent lives. A state directory may be mirrored to other
 * machines (copied, synced); exactly one of them runs it. `status.json`
 * carries the host that holds it and whether it has released, so a copy
 * elsewhere refuses to run until adopted, and a running agent whose
 * status is replaced by a newer one from another host stops: the fence.
 * A move is a `residence` frame in the log.
 */
export const HOST = hostname();

export interface Residence {
  host: string;
  /** True while a harness holds it; false once it stopped cleanly. */
  running: boolean;
  at: number;
}

export interface Status extends Residence {
  name: string;
  open: string[];
  runs: { id: string; procedure: string; from: string; startedAt: number }[];
  active: boolean;
  /** An inception requested from the outer host (auto mode): its number. */
  incepting?: number;
  /** The exposed procedures: what `endo commands` prints. */
  commands: { name: string; description: string; args: Record<string, unknown>; required: string[] }[];
  failure?: LoadFailure;
}

/** Read the status record once; failed startup may have written only residence and failure fields. */
export function readStatus(paths: Paths): Partial<Status> | null {
  try {
    const value = JSON.parse(readFileSync(paths.status, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function readResidence(paths: Paths): Residence | null {
  const s = readStatus(paths);
  return s && typeof s.host === "string" && typeof s.at === "number"
    ? { host: s.host, running: s.running === true, at: s.at } : null;
}

/** Another host holds it and has not released. */
export function heldElsewhere(paths: Paths): Residence | null {
  const r = readResidence(paths);
  return r && r.host !== HOST && r.running ? r : null;
}

/** Take a state directory another host holds: one frame saying so, and the status restamped with this host, released. Null when nothing held it. */
export function adopt(paths: Paths): Residence | null {
  const held = heldElsewhere(paths);
  if (!held) return null;
  const store = openSqliteStore(paths.db);
  store.append({ type: "residence", summary: `adopted from ${held.host} (held since ${since(held.at)})`, at: Date.now(), payload: { from: held.host, heldAt: held.at } });
  store.close();
  const status = JSON.parse(readFileSync(paths.status, "utf8")) as Record<string, unknown>;
  writeFileSync(paths.status, JSON.stringify({ ...status, host: HOST, running: false, at: Date.now() }));
  return held;
}

export const since = (at: number) => new Date(at).toISOString();

/**
 * The last time this program was tried and did not load. Kept in
 * `status.json` beside the residence fields so `endo status`, the bare
 * listing, and the wire commands can say why the agent is down without
 * opening the store. Keyed to the program's hash: once the program changes
 * (an inception wrote a new one) the record no longer applies and reads as
 * absent. A load that succeeds rewrites the whole file without it.
 */
export interface LoadFailure {
  stage: string;
  error: string;
  /** Hash of the program that failed (`hashOf(paths.program)`). */
  program: string;
  at: number;
}

export function writeLoadFailure(paths: Paths, failure: LoadFailure): void {
  let status: Record<string, unknown> = {};
  try {
    status = JSON.parse(readFileSync(paths.status, "utf8")) as Record<string, unknown>;
  } catch {}
  writeFileSync(paths.status, JSON.stringify({ ...status, host: HOST, running: false, at: failure.at, failure }));
}
