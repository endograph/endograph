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

export function readResidence(paths: Paths): Residence | null {
  try {
    const s = JSON.parse(readFileSync(paths.status, "utf8")) as Partial<Residence>;
    return typeof s.host === "string" && typeof s.at === "number" ? { host: s.host, running: s.running === true, at: s.at } : null;
  } catch {
    return null;
  }
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
