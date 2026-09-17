import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathsOf } from "../harness/paths.ts";
import { archivePath, checkpointPath, copyArchive, readAfter, START } from "./archive.ts";
import { checkpointCursor, checkpointStore } from "./sqlite.ts";

// Runtime files are either rebuilt, in flight, machine-local, credentials, or produced by the capture itself.
const LOCAL = new Set(["frames", "agent.db", "agent.db-wal", "agent.db-shm", "checkpoint.db", "lock", "lock-journal", "env", "endo.log", "status.json", "inbox", "outbox", "runs", "tmp", "candidate", "workspace", "node_modules", ".git", "local"]);
const changed = () => new Error("agent files changed while copying; retry snapshot when code and owner files are stable");

/**
 * Capture a consistent agent: a database checkpoint, the archive through the
 * commit that checkpoint stands at, and the stable agent files. The live
 * database is read only to write the checkpoint; the copy never opens it.
 */
export function snapshotAgent(agentDir: string, destination: string): { directory: string; commit: number } {
  const source = realpathSync(agentDir);
  const paths = pathsOf(source);
  const requested = resolve(destination);
  if (requested === source || requested.startsWith(`${source}/`)) throw new Error("snapshot destination must be outside the agent directory");
  mkdirSync(dirname(requested), { recursive: true });
  const directory = join(realpathSync(dirname(requested)), basename(requested));
  if (directory === source || directory.startsWith(`${source}/`)) throw new Error("snapshot destination must be outside the agent directory");
  if (lstatSync(directory, { throwIfNoEntry: false })) throw new Error(`snapshot destination already exists: ${directory}`);
  if (!existsSync(paths.program)) throw new Error("no agent program to snapshot; run endo up first");
  const promotion = join(paths.state, "promotion.json");
  if (existsSync(promotion)) throw new Error("inception promotion is unfinished; complete or recover it before taking a snapshot");
  if (!existsSync(archivePath(paths.db))) throw new Error("no frame archive to snapshot; run endo up first");

  const before = files(source);
  const residence = existsSync(paths.status) ? readFileSync(paths.status) : undefined;
  const temporary = mkdtempSync(join(dirname(directory), `.${basename(directory)}-`));
  try {
    // The checkpoint is taken after the index catches up with the archive, so
    // the archive prefix copied below is exactly what the checkpoint indexes.
    checkpointStore(paths.db);
    // Copy using the same walk as the stability check: additions, removals and
    // edits all invalidate the result, while frame appends may continue freely.
    if (files(source, temporary) !== before) throw changed();
    const target = pathsOf(temporary);
    copyFileSync(checkpointPath(paths.db), checkpointPath(target.db));
    // Another snapshot may replace the source checkpoint. Use the position in
    // our own immutable copy, never a position read before copying it.
    const cursor = checkpointCursor(checkpointPath(target.db));
    if (!cursor.commit) throw new Error("no frame archive to snapshot; run endo up first");
    copyArchive(archivePath(paths.db), archivePath(target.db), cursor);
    let programHash: string | undefined;
    const copied = readAfter(archivePath(target.db), START, (record) => {
      for (const frame of record.frames) if (frame.type === "inception") programHash = (frame.payload as { program: string }).program;
    });
    if (copied.torn || copied.cursor.commit !== cursor.commit) throw new Error(`copied frame archive ends at commit ${copied.cursor.commit}, not the checkpoint's ${cursor.commit}`);
    if (programHash && createHash("sha256").update(readFileSync(target.program)).digest("hex").slice(0, 16) !== programHash)
      throw new Error("program differs from the captured inception; restore the recorded program or run endo incept before snapshotting");
    if (files(source) !== before || existsSync(promotion)) throw changed();
    // Keep the residence claim, so restoring on another host still requires adoption.
    if (residence) writeFileSync(target.status, residence);
    syncTree(temporary);
    if (lstatSync(directory, { throwIfNoEntry: false })) throw new Error(`snapshot destination already exists: ${directory}`);
    renameSync(temporary, directory);
    sync(dirname(directory));
    return { directory, commit: cursor.commit };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Hash selected paths and contents; optionally copy those exact bytes too. */
function files(root: string, destination?: string): string {
  const hash = createHash("sha256");
  function walk(path: string): void {
    const name = relative(root, path);
    if (name === ".env" || name === ".git" || name === "node_modules") return;
    if (dirname(name) === ".endo" && LOCAL.has(basename(name))) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`snapshot requires ordinary files and directories: ${name}`);
    hash.update(JSON.stringify([name, stat.mode]));
    const target = destination ? join(destination, name) : undefined;
    if (stat.isDirectory()) {
      if (target) mkdirSync(target, { recursive: true });
      for (const child of readdirSync(path).sort()) walk(join(path, child));
    } else {
      const bytes = readFileSync(path);
      hash.update(createHash("sha256").update(bytes).digest());
      if (target) writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
    }
    if (target) chmodSync(target, stat.mode & 0o777);
  }
  for (const child of readdirSync(root).sort()) walk(join(root, child));
  return hash.digest("hex");
}

function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncTree(path: string): void {
  if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) syncTree(join(path, child));
  sync(path);
}
