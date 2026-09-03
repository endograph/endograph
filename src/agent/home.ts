import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A home is where an agent lives and runs. It links back to its declaration
 * and holds the running state under agent/. One structure wherever it sits:
 *
 *   <home>/declaration -> <declaration dir>
 *   <home>/env                    optional KEY=VALUE credentials
 *   <home>/agent/{lock,agent.db,inbox/,outbox/,src/}
 */

export const DECLARATION_FILE = "endograph.ts";
const LINK = "declaration";

export interface HomePaths {
  root: string;
  /** Resolved declaration directory. */
  declaration: string;
  agentDir: string;
  lockPath: string;
  dbPath: string;
  inboxDir: string;
  outboxDir: string;
  srcDir: string;
  envPath: string;
  /** Written when hydration failed after every migration; `endo doctor` reports it, `endo up` clears it on success. */
  needsHumanPath: string;
}

export function homePaths(root: string, declaration: string): HomePaths {
  const agentDir = join(root, "agent");
  return {
    root,
    declaration,
    agentDir,
    lockPath: join(agentDir, "lock"),
    dbPath: join(agentDir, "agent.db"),
    inboxDir: join(agentDir, "inbox"),
    outboxDir: join(agentDir, "outbox"),
    srcDir: join(agentDir, "src"),
    envPath: join(root, "env"),
    needsHumanPath: join(agentDir, "needs-human"),
  };
}

export function isDeclarationDir(dir: string): boolean {
  const file = join(dir, DECLARATION_FILE);
  return existsSync(file) && statSync(file).isFile();
}

export function isHomeDir(dir: string): boolean {
  try {
    return lstatSync(join(dir, LINK)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where a new home goes when `--home` is not given. */
export function defaultHome(declarationDir: string, name: string): string {
  return join(declarationDir, ".endo", name);
}

/** The declaration a home links to, resolved. Throws when the link dangles. */
export function readDeclarationLink(home: string): string {
  const link = join(home, LINK);
  const target = readlinkSync(link);
  const path = isAbsolute(target) ? target : resolve(dirname(link), target);
  if (!isDeclarationDir(path)) {
    throw new Error(`${link} -> ${path} is not a declaration directory (no ${DECLARATION_FILE}); run \`endo up ${home} --declaration <dir>\``);
  }
  return realpathSync(path);
}

/** Create a home for a declaration; a relative link when the home is inside it. */
export function createHome(root: string, declarationDir: string): HomePaths {
  const declaration = realpathSync(declarationDir);
  mkdirSync(root, { recursive: true });
  const home = realpathSync(root);
  const link = join(home, LINK);
  if (!existsSync(link)) {
    const inside = !relative(declaration, home).startsWith("..");
    symlinkSync(inside ? relative(home, declaration) || "." : declaration, link);
  }
  return ensureAgentDirs(homePaths(home, declaration));
}

export function ensureAgentDirs(paths: HomePaths): HomePaths {
  for (const dir of [paths.agentDir, paths.inboxDir, paths.outboxDir, paths.srcDir]) mkdirSync(dir, { recursive: true });
  return paths;
}

/**
 * Credentials: the environment wins; the home's env file fills gaps.
 * Lines are KEY=VALUE (optional `export `, optional quotes).
 */
export function loadEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

/**
 * The running lock: an exclusive SQLite transaction held for the life of
 * the process. The OS releases it on death, so no stale pid files. A
 * second opener fails immediately.
 */
export interface Lock {
  release(): void;
}

export function acquireLock(lockPath: string): Lock | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const db = new Database(lockPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    return null;
  }
  return {
    release() {
      try {
        db.exec("COMMIT;");
      } catch {}
      db.close();
    },
  };
}

export function isRunning(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const lock = acquireLock(lockPath);
  if (!lock) return true;
  lock.release();
  return false;
}
