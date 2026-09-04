import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `~/.endograph/agents/<name>` is a symlink to the agent directory, claimed
 * whenever `up` runs. Data, not code: any endo binary reads and writes it.
 * One agent directory per name per machine; a worktree cannot steal a name
 * from a stopped agent whose directory still exists.
 */

export function registryDir(): string {
  return join(process.env.ENDOGRAPH_HOME ?? join(homedir(), ".endograph"), "agents");
}

export class NameConflict extends Error {
  constructor(
    readonly name: string,
    readonly heldBy: string,
  ) {
    super(`"${name}" is registered to ${heldBy}, which still exists; rename this agent or remove that one`);
  }
}

export interface Entry {
  name: string;
  dir: string;
  /** The directory the entry points at still exists. */
  exists: boolean;
}

export function claim(name: string, agentDir: string): void {
  const dir = realpathSync(agentDir);
  mkdirSync(registryDir(), { recursive: true });
  const link = join(registryDir(), name);
  const current = lookup(name);
  if (current) {
    if (current.exists && realpathSync(current.dir) === dir) return;
    if (current.exists) throw new NameConflict(name, current.dir);
    unlinkSync(link);
  }
  // A rename: any other entry pointing here goes.
  for (const entry of list()) if (entry.exists && realpathSync(entry.dir) === dir && entry.name !== name) unlinkSync(join(registryDir(), entry.name));
  symlinkSync(dir, link);
}

export function lookup(name: string): Entry | null {
  const link = join(registryDir(), name);
  try {
    lstatSync(link);
  } catch {
    return null;
  }
  const dir = readlinkSync(link);
  return { name, dir, exists: existsSync(join(dir, "endograph.toml")) };
}

export function list(): Entry[] {
  try {
    return readdirSync(registryDir())
      .sort()
      .map((name) => lookup(name))
      .filter((e): e is Entry => e !== null);
  } catch {
    return [];
  }
}

export function release(name: string): void {
  try {
    unlinkSync(join(registryDir(), name));
  } catch {}
}

/** `--agent <name|dir>`: a directory holding a grant wins; otherwise the registry. Null when neither. */
export function resolveAgent(arg: string): string | null {
  const dir = resolve(arg);
  if (existsSync(join(dir, "endograph.toml"))) return dir;
  if (!/[/.]/.test(arg)) {
    const entry = lookup(arg);
    if (entry?.exists) return entry.dir;
  }
  return null;
}
