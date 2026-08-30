import type { AgentDir } from "../agent/dir.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames, printFrame, endoPayload } from "./shared.ts";

/** `endo why metro` — recent frames about a subject; accepts loose names. */
export async function cmdWhy(dir: AgentDir, thing: string): Promise<number> {
  const store = openSqliteStore(dir.dbPath);
  const frames = allFrames(store).filter(
    (f) => f.subject != null && f.subject.includes(thing),
  );
  store.close();
  if (frames.length === 0) {
    console.log(`no frames mention "${thing}"`);
    return 1;
  }
  for (const frame of frames.slice(-25)) printFrame(frame);
  return 0;
}

/** `endo replay inc-1a2b3c4d` — the full frame sequence of one incident. */
export async function cmdReplay(dir: AgentDir, incident: string): Promise<number> {
  const store = openSqliteStore(dir.dbPath);
  const frames = allFrames(store).filter((f) => f.incident === incident);
  store.close();
  if (frames.length === 0) {
    console.log(`no incident "${incident}"`);
    return 1;
  }
  for (const frame of frames) {
    printFrame(frame);
    const detail = endoPayload(frame)?.detail;
    if (typeof detail === "string") {
      for (const line of detail.split("\n").slice(-15)) {
        console.log(`    ${line}`);
      }
    }
  }
  return 0;
}
