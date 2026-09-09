import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Frame, Snapshot } from "./types.ts";

/** One immutable filesystem commit. A checkpoint and its frames are published together. */
export interface ArchiveCommit {
  version: 1;
  commit: number;
  frames: Frame[];
  snapshot?: Snapshot;
}

export const archivePath = (database: string): string => join(dirname(database), "frames");
const filename = (commit: number) => `${String(commit).padStart(20, "0")}.json`;
export const commitPath = (archive: string, commit: number): string => join(archive, filename(commit));

export function ensureArchive(archive: string): void {
  if (existsSync(archive)) return;
  mkdirSync(archive, { recursive: true });
  syncDirectory(dirname(archive));
}

/** Only final commit names count; interrupted temporary files carry no decision. */
export function commitNumbers(archive: string): number[] {
  if (!existsSync(archive)) return [];
  return readdirSync(archive).filter((name) => /^\d{20}\.json$/.test(name)).sort().map((name, index) => {
    const commit = Number(name.slice(0, -5));
    if (!Number.isSafeInteger(commit) || commit !== index + 1) throw new Error(`incomplete frame archive: expected commit ${index + 1}, found ${name}`);
    return commit;
  });
}

export function readCommit(archive: string, commit: number): ArchiveCommit {
  const path = commitPath(archive, commit);
  const value = JSON.parse(readFileSync(path, "utf8")) as ArchiveCommit;
  if (value.version !== 1 || value.commit !== commit || !Array.isArray(value.frames)) throw new Error(`invalid frame archive commit: ${path}`);
  return value;
}

/** The link publishes without ever replacing an existing immutable commit. */
export function publishCommit(archive: string, commit: ArchiveCommit): void {
  const temporary = join(archive, `.${filename(commit.commit)}.${crypto.randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(commit));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, commitPath(archive, commit.commit));
    syncDirectory(archive);
  } finally {
    // A leftover temporary file is harmless. Never undo a published decision.
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
