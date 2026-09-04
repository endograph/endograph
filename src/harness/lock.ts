import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One process per agent: an exclusive SQLite transaction on `.endo/lock`,
 * released by the OS when the holder dies, so a crash never leaves a stale
 * lock behind.
 */
export interface Lock {
  release(): void;
}

export function acquireLock(path: string): Lock | null {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
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

export function isLocked(path: string): boolean {
  if (!existsSync(path)) return false;
  const lock = acquireLock(path);
  if (!lock) return true;
  lock.release();
  return false;
}
