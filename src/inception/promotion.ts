import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "../harness/paths.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames, type FrameInput, type Snapshot } from "../store/types.ts";

/** The archive commit decides whether recovery keeps the new program or restores the backup.
 * Under the agent lock, recover before any program is loaded or inception starts.
 */
interface Promotion { token: string; n: number; program: boolean; src: boolean; ownerFiles?: { path: string; existed: boolean }[] }
const journal = (paths: Paths) => join(paths.state, "promotion.json");
const backup = (paths: Paths) => join(paths.state, "promotion-backup");

export function recoverPromotion(paths: Paths): void {
  if (!existsSync(journal(paths))) return;
  const pending = JSON.parse(readFileSync(journal(paths), "utf8")) as Promotion;
  const store = openSqliteStore(paths.db);
  let committed = false;
  try {
    for (const f of allFrames(store)) {
      if (f.type === "inception" && (f.payload as { promotion?: string })?.promotion === pending.token) { committed = true; break; }
    }
  } finally { store.close(); }
  if (!committed) {
    for (const [name, target] of [["program", dirname(paths.program)], ["src", paths.src]] as const) {
      const saved = join(backup(paths), name);
      if (existsSync(saved)) {
        rmSync(target, { recursive: true, force: true });
        cpSync(saved, target, { recursive: true });
      } else if (!pending[name]) rmSync(target, { recursive: true, force: true });
    }
    for (const [i, file] of (pending.ownerFiles ?? []).entries()) {
      if (file.existed) writeFileSync(file.path, readFileSync(join(backup(paths), `owner-${i}`)));
      else rmSync(file.path, { force: true });
    }
    rmSync(join(paths.snapshots, String(pending.n)), { recursive: true, force: true });
  }
  // Remove the decision journal before its recovery evidence. Cleanup is repeatable.
  syncTree(dirname(paths.program));
  syncTree(paths.src);
  syncTree(paths.snapshots);
  for (const file of pending.ownerFiles ?? []) { syncTree(file.path); syncDirectory(dirname(file.path)); }
  syncDirectory(paths.state);
  rmSync(journal(paths));
  syncDirectory(paths.state);
  rmSync(backup(paths), { recursive: true, force: true });
}

export function promote(paths: Paths, candidate: Paths, n: number, frame: FrameInput, snapshot: Omit<Snapshot, "asOfSeq">, ownerFiles: { path: string; contents: string }[] = []): void {
  const pending: Promotion = { token: randomUUID(), n, program: existsSync(dirname(paths.program)), src: existsSync(paths.src), ownerFiles: ownerFiles.map(file => ({ path: file.path, existed: existsSync(file.path) })) };
  rmSync(backup(paths), { recursive: true, force: true });
  mkdirSync(backup(paths), { recursive: true });
  // Make rollback evidence before publishing the journal or changing either live tree.
  for (const [name, target] of [["program", dirname(paths.program)], ["src", paths.src]] as const)
    if (pending[name]) cpSync(target, join(backup(paths), name), { recursive: true });
  for (const [i, file] of pending.ownerFiles!.entries()) {
    mkdirSync(dirname(file.path), { recursive: true });
    if (file.existed) writeFileSync(join(backup(paths), `owner-${i}`), readFileSync(file.path));
  }
  syncTree(backup(paths));
  syncTree(join(paths.snapshots, String(n)));
  syncDirectory(paths.snapshots);
  const tmp = `${journal(paths)}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending));
  syncFile(tmp);
  renameSync(tmp, journal(paths));
  syncDirectory(paths.state);
  const store = openSqliteStore(paths.db);
  try {
    for (const [source, target] of [[dirname(candidate.program), dirname(paths.program)], [candidate.src, paths.src]]) {
      rmSync(target!, { recursive: true, force: true });
      cpSync(source!, target!, { recursive: true });
    }
    for (const file of ownerFiles) {
      writeFileSync(file.path, file.contents);
      syncFile(file.path);
      syncDirectory(dirname(file.path));
    }
    syncTree(dirname(paths.program));
    syncTree(paths.src);
    syncDirectory(paths.state);
    store.transaction(() => {
      store.append({ ...frame, payload: { ...(frame.payload as object), promotion: pending.token } });
      store.writeSnapshot({ ...snapshot, asOfSeq: store.lastSeq() });
    });
  } finally {
    store.close();
    recoverPromotion(paths);
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { syncFile(path); }
function syncTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) for (const child of readdirSync(path)) syncTree(join(path, child));
  syncFile(path);
}
