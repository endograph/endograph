import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRunning, readDeclarationLink, homePaths, isHomeDir } from "./home.ts";

/**
 * The registry: ~/.endograph/agents/<name> -> <home>. Claimed by the agent
 * whenever it starts. Data, not code: any endo binary reads and writes it.
 */

export function registryDir(): string {
  return process.env.ENDOGRAPH_HOME ? join(process.env.ENDOGRAPH_HOME, "agents") : join(homedir(), ".endograph", "agents");
}

export interface RegistryEntry {
  name: string;
  /** Link target as written. */
  home: string;
  /** The home still exists (has its declaration link). */
  exists: boolean;
}

export function lookup(name: string): RegistryEntry | null {
  const link = join(registryDir(), name);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const home = readlinkSync(link);
  return { name, home, exists: isHomeDir(home) };
}

export function list(): RegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(registryDir());
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => lookup(n))
    .filter((e): e is RegistryEntry => e !== null);
}

export class NameConflict extends Error {
  constructor(
    public name: string,
    public other: string,
    public running: boolean,
  ) {
    super(`agent "${name}" is already registered at ${other}${running ? " (running)" : " (stopped)"}; a name is never taken from an existing home`);
  }
}

/**
 * Claim `name` for `home`. Same home: fine. Another home that still exists,
 * running or stopped: refused. A vanished home: replaced. Any other entry
 * pointing at this home is the old name of a renamed agent: removed.
 */
export function claim(name: string, home: string): void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(home);
  const current = lookup(name);
  if (current && current.exists && !sameDir(current.home, real)) {
    throw new NameConflict(name, current.home, isRunning(homePaths(current.home, "").lockPath));
  }
  for (const entry of list()) {
    if (entry.name !== name && entry.exists && sameDir(entry.home, real)) unlinkSync(join(dir, entry.name));
  }
  const link = join(dir, name);
  if (current) unlinkSync(link);
  symlinkSync(real, link);
}

/** The home registered for a declaration directory, if any. */
export function findByDeclaration(declarationDir: string): RegistryEntry | null {
  const real = realpathSync(declarationDir);
  for (const entry of list()) {
    if (!entry.exists) continue;
    try {
      if (readDeclarationLink(entry.home) === real) return entry;
    } catch {}
  }
  return null;
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function homeExists(home: string): boolean {
  return existsSync(home) && isHomeDir(home);
}
