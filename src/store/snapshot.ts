import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathsOf } from "../harness/paths.ts";
import { archivePath, commitNumbers, publishCommit, readCommit } from "./archive.ts";

// Runtime files are either rebuilt, in flight, machine-local, or credentials.
const LOCAL = new Set(["frames", "agent.db", "agent.db-wal", "agent.db-shm", "lock", "lock-journal", "env", "endo.log", "status.json", "inbox", "outbox", "runs", "tmp", "candidate", "workspace", "node_modules", ".git", "codex"]);
const changed = () => new Error("agent files changed while copying; retry snapshot when code and owner files are stable");

/** Copy a fixed archive prefix and stable agent files. Never opens the live database. */
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

  const before = files(source);
  const archive = archivePath(paths.db);
  const commits = commitNumbers(archive);
  if (!commits.length) throw new Error("no frame archive to snapshot; run endo up first");
  const residence = existsSync(paths.status) ? readFileSync(paths.status) : undefined;
  const temporary = mkdtempSync(join(dirname(directory), `.${basename(directory)}-`));
  try {
    // Copy using the same walk as the stability check: additions, removals and
    // edits all invalidate the result, while frame appends may continue freely.
    if (files(source, temporary) !== before) throw changed();
    const target = pathsOf(temporary);
    const targetArchive = archivePath(target.db);
    mkdirSync(targetArchive, { recursive: true });
    let programHash: string | undefined;
    for (const commit of commits) {
      const record = readCommit(archive, commit);
      for (const frame of record.frames) if (frame.type === "inception") programHash = (frame.payload as { program: string }).program;
      publishCommit(targetArchive, record);
    }
    if (programHash && createHash("sha256").update(readFileSync(target.program)).digest("hex").slice(0, 16) !== programHash)
      throw new Error("program differs from the captured inception; restore the recorded program or run endo incept before snapshotting");
    if (files(source) !== before || existsSync(promotion)) throw changed();
    // Keep the residence claim, so restoring on another host still requires adoption.
    if (residence) writeFileSync(target.status, residence);
    syncTree(temporary);
    if (lstatSync(directory, { throwIfNoEntry: false })) throw new Error(`snapshot destination already exists: ${directory}`);
    renameSync(temporary, directory);
    sync(dirname(directory));
    return { directory, commit: commits.at(-1)! };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Hash selected paths and contents; optionally copy those exact bytes too. */
function files(root: string, destination?: string): string {
  const hash = createHash("sha256");
  function walk(path: string): void {
    const name = relative(root, path);
    if (name === ".git" || name === "node_modules") return;
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
