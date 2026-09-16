import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Frame, Snapshot } from "./types.ts";

/**
 * The frame archive: the durable commit decision, one record per store
 * transaction. Two encodings share `frames/`: the legacy prefix of immutable
 * `<commit>.json` files (one commit each, never rewritten), followed by
 * append-only `<first commit>.jsonl` segments holding one JSON record per
 * line. A record is published once its terminating newline is on disk. A
 * segment is named by its first commit, so the segment after commit `n`
 * ends is always `<n+1>.jsonl`: reading needs no directory listing.
 */
export interface ArchiveCommit {
  version: 1;
  commit: number;
  frames: Frame[];
  snapshot?: Snapshot;
}

export const archivePath = (database: string): string => join(dirname(database), "frames");
/** The portable database checkpoint beside the live database (see `checkpointStore`). */
export const checkpointPath = (database: string): string => join(dirname(database), "checkpoint.db");

const number = (n: number) => String(n).padStart(20, "0");
const LEGACY = /^\d{20}\.json$/;
const SEGMENT = /^\d{20}\.jsonl$/;
/** Legacy: the immutable file holding exactly one commit. */
export const commitPath = (archive: string, commit: number): string => join(archive, `${number(commit)}.json`);
export const segmentName = (first: number): string => `${number(first)}.jsonl`;
const firstOf = (segment: string) => Number(segment.slice(0, 20));

/** Rotate before appending once the active segment holds this many frames or bytes. */
export interface SegmentPolicy { frames: number; bytes: number }
export const SEGMENT_POLICY: SegmentPolicy = { frames: 1000, bytes: 16 * 1024 * 1024 };

/** Where an index stands: the last commit applied and the byte position after it in its segment (`null` while only legacy files exist). */
export interface ArchiveCursor {
  commit: number;
  segment: string | null;
  offset: number;
  /** Frames written to `segment` so far; decides rotation without reading the file. */
  frames: number;
}
export const START: ArchiveCursor = { commit: 0, segment: null, offset: 0, frames: 0 };

export function ensureArchive(archive: string): void {
  if (existsSync(archive)) return;
  mkdirSync(archive, { recursive: true });
  syncDirectory(dirname(archive));
}

export interface ArchiveLayout {
  /** Legacy commits 1..legacy, verified contiguous by name. */
  legacy: number;
  /** Segment names in commit order, each verified to continue the previous one. */
  segments: string[];
  /** The last published commit. */
  head: number;
}

/**
 * List and verify the archive by names and segment tails: legacy files must be
 * 1..n, every segment must start where the previous one ended, and only the
 * final segment may end in an unterminated record. Interior records are
 * verified when read.
 */
export function readLayout(archive: string): ArchiveLayout {
  if (!existsSync(archive)) return { legacy: 0, segments: [], head: 0 };
  const names = readdirSync(archive);
  const legacy = names.filter((name) => LEGACY.test(name)).sort();
  legacy.forEach((name, index) => {
    const commit = Number(name.slice(0, -5));
    if (!Number.isSafeInteger(commit) || commit !== index + 1) throw new Error(`incomplete frame archive: expected commit ${index + 1}, found ${name}`);
  });
  const segments = names.filter((name) => SEGMENT.test(name)).sort();
  let head = legacy.length;
  segments.forEach((name, index) => {
    if (firstOf(name) !== head + 1) throw new Error(`incomplete frame archive: segment ${name} does not continue commit ${head}`);
    const tail = tailOf(join(archive, name));
    const final = index === segments.length - 1;
    if (!final && (!tail.terminated || !tail.last)) throw new Error(`corrupt frame archive: segment ${name} ends before ${segments[index + 1]} begins`);
    head = tail.last ? tail.last.commit : head;
  });
  return { legacy: legacy.length, segments, head };
}

/** Every commit number in order; the layout is verified first. */
export function commitNumbers(archive: string): number[] {
  return Array.from({ length: readLayout(archive).head }, (_, index) => index + 1);
}

/** One commit, from its legacy file or by scanning the segment that starts at or before it. */
export function readCommit(archive: string, commit: number): ArchiveCommit {
  const legacy = commitPath(archive, commit);
  if (existsSync(legacy)) return parseRecord(readFileSync(legacy), commit, legacy);
  const segment = readLayout(archive).segments.filter((name) => firstOf(name) <= commit).at(-1);
  if (!segment) throw new Error(`frame archive has no commit ${commit}`);
  let found: ArchiveCommit | undefined;
  readAfter(archive, { commit: firstOf(segment) - 1, segment, offset: 0, frames: 0 }, (entry) => {
    if (entry.commit === commit) found = entry;
    return entry.commit < commit;
  });
  if (!found) throw new Error(`frame archive has no commit ${commit}`);
  return found;
}

export interface ReadResult {
  cursor: ArchiveCursor;
  /** The final segment ends in an unterminated record: bytes to keep. Truncate only while holding the store's write lock. */
  torn?: { path: string; keep: number };
}

/**
 * Visit every commit after the cursor in order. Fails closed on a complete
 * but invalid record, a commit out of sequence, a segment shorter than the
 * cursor, or an unterminated record in any segment but the last. Stops early
 * when `visit` returns false.
 */
export function readAfter(archive: string, from: ArchiveCursor, visit: (commit: ArchiveCommit) => boolean | void): ReadResult {
  let cursor = { ...from };
  if (cursor.segment === null) {
    for (;;) {
      const path = commitPath(archive, cursor.commit + 1);
      if (!existsSync(path)) break;
      const entry = parseRecord(readFileSync(path), cursor.commit + 1, path);
      const more = visit(entry);
      cursor = { commit: entry.commit, segment: null, offset: 0, frames: 0 };
      if (more === false) return { cursor };
    }
    const next = segmentName(cursor.commit + 1);
    if (!existsSync(join(archive, next))) return { cursor };
    cursor = { commit: cursor.commit, segment: next, offset: 0, frames: 0 };
  }
  for (;;) {
    const path = join(archive, cursor.segment!);
    const baseOffset = cursor.offset;
    const bytes = readFrom(path, baseOffset);
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(10, start);
      if (newline === -1) break;
      const entry = parseRecord(bytes.subarray(start, newline), cursor.commit + 1, `${path} at byte ${baseOffset + start}`);
      const more = visit(entry);
      cursor = { commit: entry.commit, segment: cursor.segment, offset: baseOffset + newline + 1, frames: cursor.frames + entry.frames.length };
      start = newline + 1;
      if (more === false) return { cursor };
    }
    const unterminated = bytes.length - start;
    const next = segmentName(cursor.commit + 1);
    if (next === cursor.segment || !existsSync(join(archive, next))) return unterminated ? { cursor, torn: { path, keep: cursor.offset } } : { cursor };
    if (unterminated) throw new Error(`corrupt frame archive: ${path} ends in an unterminated record before ${next} begins`);
    cursor = { commit: cursor.commit, segment: next, offset: 0, frames: 0 };
  }
}

/** Publish one commit after the cursor: the same segment, or a fresh one when the policy says so. Call only inside the store's write transaction. */
export function appendCommit(archive: string, cursor: ArchiveCursor, entry: ArchiveCommit, policy: SegmentPolicy = SEGMENT_POLICY): ArchiveCursor {
  if (entry.commit !== cursor.commit + 1) throw new Error(`archive commit ${entry.commit} does not follow ${cursor.commit}`);
  const line = Buffer.from(`${JSON.stringify(entry)}\n`);
  const rotate = cursor.segment === null || (cursor.offset > 0 && (cursor.frames >= policy.frames || cursor.offset >= policy.bytes));
  const segment = rotate ? segmentName(entry.commit) : cursor.segment!;
  const offset = rotate ? 0 : cursor.offset;
  const fd = openSync(join(archive, segment), "a", 0o600);
  try {
    const size = fstatSync(fd).size;
    if (size !== offset) throw new Error(`frame archive segment ${segment} holds ${size} bytes; the index expected ${offset}`);
    for (let written = 0; written < line.length;) written += writeSync(fd, line, written, line.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (rotate) syncDirectory(archive);
  return { commit: entry.commit, segment, offset: offset + line.length, frames: (rotate ? 0 : cursor.frames) + entry.frames.length };
}

/** Discard an unterminated tail. The caller holds the store's write lock, so no publication is in flight. */
export function truncateSegment(path: string, keep: number): void {
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, keep);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copy the archive through `cursor` byte for byte: whole legacy files and complete segments, the cursor's segment up to its offset. */
export function copyArchive(source: string, destination: string, cursor: ArchiveCursor): void {
  const layout = readLayout(source);
  mkdirSync(destination, { recursive: true });
  for (let commit = 1; commit <= Math.min(layout.legacy, cursor.commit); commit++) copyBytes(commitPath(source, commit), commitPath(destination, commit));
  if (cursor.segment === null) return;
  for (const name of layout.segments) {
    if (firstOf(name) > cursor.commit) break;
    copyBytes(join(source, name), join(destination, name), name === cursor.segment ? cursor.offset : undefined);
  }
}

/** Legacy writer, retained for fixtures: one immutable file per commit, linked into place without ever replacing one. */
export function publishCommit(archive: string, commit: ArchiveCommit): void {
  const temporary = join(archive, `.${number(commit.commit)}.json.${crypto.randomUUID()}.tmp`);
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
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

/** A complete record must be valid JSON of the right shape and, when known, the expected commit. Anything else fails closed. */
function parseRecord(bytes: Uint8Array, commit: number | undefined, where: string): ArchiveCommit {
  let value: ArchiveCommit;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as ArchiveCommit;
  } catch {
    throw new Error(`corrupt frame archive: invalid record in ${where}`);
  }
  if (!value || typeof value !== "object" || value.version !== 1 || !Number.isSafeInteger(value.commit) || !Array.isArray(value.frames)) throw new Error(`corrupt frame archive: invalid record in ${where}`);
  if (commit !== undefined && value.commit !== commit) throw new Error(`corrupt frame archive: expected commit ${commit}, found ${value.commit} in ${where}`);
  return value;
}

/** The last complete record of a segment and whether the file ends with a newline; reads only the tail. */
function tailOf(path: string): { last: ArchiveCommit | null; terminated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { last: null, terminated: true };
    let start = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;
    while (newlines < 2 && start > 0) {
      const length = Math.min(64 * 1024, start);
      const chunk = Buffer.alloc(length);
      readFully(fd, chunk, start - length);
      buffer = Buffer.concat([chunk, buffer]);
      start -= length;
      newlines = 0;
      for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) newlines++;
    }
    const terminated = buffer[buffer.length - 1] === 10;
    // The newline ending the last complete record, and the one before it.
    const end = buffer.lastIndexOf(10);
    if (end === -1) return { last: null, terminated };
    const previous = end === 0 ? -1 : buffer.lastIndexOf(10, end - 1);
    return { last: parseRecord(buffer.subarray(previous + 1, end), undefined, `${path} tail`), terminated };
  } finally {
    closeSync(fd);
  }
}

function readFrom(path: string, offset: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) throw new Error(`corrupt frame archive: ${path} holds ${size} bytes, fewer than the ${offset} already indexed`);
    const buffer = Buffer.alloc(size - offset);
    readFully(fd, buffer, offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function readFully(fd: number, buffer: Buffer, position: number): void {
  for (let read = 0; read < buffer.length;) {
    const count = readSync(fd, buffer, read, buffer.length - read, position + read);
    if (count === 0) throw new Error("archive file shrank while reading");
    read += count;
  }
}

function copyBytes(source: string, destination: string, length?: number): void {
  const bytes = length === undefined ? readFileSync(source) : readFrom(source, 0).subarray(0, length);
  const fd = openSync(destination, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
