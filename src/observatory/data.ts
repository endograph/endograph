import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { isLocked } from "../harness/lock.ts";
import type { Paths } from "../harness/paths.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames, type Frame } from "../store/types.ts";

const FRAME_LIMIT = 500;
const ENDOGRAPH_VERSION = (JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;

interface StatusFile {
  name: string;
  open: string[];
  runs: { id: string; procedure: string; from: string; startedAt: number }[];
  active: boolean;
  at: number;
}

interface InceptionPayload {
  n: number;
  manifest?: string;
  grant?: string;
  program?: string;
  version?: string;
  inceptor?: string;
  rounds?: number;
  ms?: number;
  changes?: string;
}

export interface ObservatorySnapshot {
  agent: {
    name: string;
    dir: string;
    running: boolean;
    active: boolean;
    open: string[];
    runs: StatusFile["runs"];
    statusAt?: number;
  };
  log: {
    frames: Frame[];
    total: number;
    truncated: boolean;
  };
  machine: {
    asOfSeq: number;
    at: number;
    instance: unknown;
  } | null;
  inception: {
    latest: number;
    changed: string[];
    programEdited: boolean;
    loadError: string | null;
    history: InceptionView[];
    attempts: InceptionAttempt[];
  };
  generatedAt: number;
}

export interface InceptionView extends InceptionPayload {
  seq: number;
  at: number;
  summary: string;
  inputsChanged: string[];
  resultChanged: FileChange[];
  files: SnapshotFile[];
  shape: { nodes: string[]; states: string[]; procedures: string[] };
  artifacts: { manifest?: string; grant?: string; program?: string };
  attempt?: InceptionAttempt;
}

export interface InceptionAttempt {
  n: number;
  version?: string;
  inceptor?: string;
  prompt?: string;
  started?: string;
  finished?: string;
  rounds?: number;
  outcome: "recorded" | "failed" | "in-progress";
  error?: string;
  details: InceptionRound[];
}

interface InceptionRound {
  round: number;
  at?: string;
  passed?: boolean;
  stage?: string;
  exitCode?: number;
  inceptorMs?: number;
  validateMs?: number;
  stdout?: string;
  stderr?: string;
  errors?: string;
}

interface SnapshotFile {
  path: string;
  bytes: number;
}

interface FileChange {
  path: string;
  kind: "added" | "changed" | "removed";
}

/** Build the read-only payload consumed by the observatory browser. */
export async function readObservatorySnapshot(paths: Paths, fallbackName = basename(paths.agentDir)): Promise<ObservatorySnapshot> {
  const status = readJson<StatusFile>(paths.status);
  let frames: Frame[] = [];
  let inceptionFrames: Frame[] = [];
  let machine: ObservatorySnapshot["machine"] = null;
  if (existsSync(paths.db)) {
    const store = openSqliteStore(paths.db);
    try {
      const all = [...allFrames(store)];
      frames = all.slice(-FRAME_LIMIT);
      inceptionFrames = all.filter((frame) => frame.type === "inception");
      const snapshot = store.readSnapshot();
      if (snapshot) machine = { asOfSeq: snapshot.asOfSeq, at: snapshot.at, instance: snapshot.state };
    } finally {
      store.close();
    }
  }

  const attempts = readInceptionAttempts(paths);
  const history = inceptionFrames.map((frame, index) => {
    const view = inceptionView(paths, frame, inceptionFrames[index - 1]);
    view.attempt = attempts.find((attempt) => attempt.n === view.n);
    return view;
  });
  const drift = driftOf(paths, history.at(-1));

  const total = frames.length ? Math.max(frames.at(-1)!.seq, frames.length) : 0;
  return {
    agent: {
      name: status?.name ?? fallbackName,
      dir: paths.agentDir,
      running: isLocked(paths.lock),
      active: status?.active ?? false,
      open: status?.open ?? [],
      runs: status?.runs ?? [],
      ...(status ? { statusAt: status.at } : {}),
    },
    log: { frames, total, truncated: total > frames.length },
    machine,
    inception: { latest: drift.n, changed: drift.changed, programEdited: drift.programEdited, loadError: drift.loadError, history, attempts },
    generatedAt: Date.now(),
  };
}

function readInceptionAttempts(paths: Paths): InceptionAttempt[] {
  if (!existsSync(paths.inceptions)) return [];
  const attempts: InceptionAttempt[] = [];
  for (const name of readdirSync(paths.inceptions).sort((a, b) => Number(a) - Number(b))) {
    const dir = join(paths.inceptions, name);
    const meta = readJson<Record<string, unknown>>(join(dir, "inception.json"));
    if (!meta || typeof meta.n !== "number") continue;
    const roundsDir = join(dir, "rounds");
    const details: InceptionRound[] = [];
    if (existsSync(roundsDir)) {
      for (const roundName of readdirSync(roundsDir).sort((a, b) => Number(a) - Number(b))) {
        const roundDir = join(roundsDir, roundName);
        const round = readJson<InceptionRound>(join(roundDir, "round.json"));
        if (!round) continue;
        const stdout = clippedText(join(roundDir, "stdout.txt"));
        const stderr = clippedText(join(roundDir, "stderr.txt"));
        const errors = clippedText(join(roundDir, "ERRORS.md"));
        details.push({ ...round, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}), ...(errors ? { errors } : {}) });
      }
    }
    attempts.push({
      n: meta.n,
      ...(typeof meta.version === "string" ? { version: meta.version } : {}),
      ...(typeof meta.inceptor === "string" ? { inceptor: meta.inceptor } : {}),
      ...(typeof meta.prompt === "string" ? { prompt: meta.prompt } : {}),
      ...(typeof meta.started === "string" ? { started: meta.started } : {}),
      ...(typeof meta.finished === "string" ? { finished: meta.finished } : {}),
      ...(typeof meta.rounds === "number" ? { rounds: meta.rounds } : {}),
      outcome: meta.outcome === "recorded" || meta.outcome === "failed" ? meta.outcome : "in-progress",
      ...(typeof meta.error === "string" ? { error: meta.error } : {}),
      details,
    });
  }
  return attempts;
}

function driftOf(paths: Paths, latest?: InceptionView) {
  if (!latest) return { n: 0, changed: [] as string[], programEdited: false, loadError: null };
  const changed: string[] = [];
  let manifest: unknown = "manifest.md";
  try {
    manifest = (Bun.TOML.parse(readText(paths.grant) ?? "") as { manifest?: unknown }).manifest ?? "manifest.md";
  } catch {}
  const manifestHash =
    typeof manifest === "object" && manifest && typeof (manifest as { text?: unknown }).text === "string"
      ? createHash("sha256").update((manifest as { text: string }).text).digest("hex").slice(0, 16)
      : fileHash(resolve(paths.agentDir, typeof manifest === "string" ? manifest : "manifest.md"));
  if (manifestHash !== latest.manifest) changed.push("manifest");
  if (fileHash(paths.grant) !== latest.grant) changed.push("grant");
  if (ENDOGRAPH_VERSION !== latest.version) changed.push("endograph");
  return {
    n: latest.n,
    changed,
    programEdited: existsSync(paths.program) && fileHash(paths.program) !== latest.program,
    loadError: null,
  };
}

function inceptionView(paths: Paths, frame: Frame, previous?: Frame): InceptionView {
  const payload = (frame.payload ?? {}) as InceptionPayload;
  const n = typeof payload.n === "number" ? payload.n : 0;
  const previousPayload = (previous?.payload ?? {}) as InceptionPayload;
  const dir = join(paths.snapshots, String(n));
  const previousDir = previousPayload.n ? join(paths.snapshots, String(previousPayload.n)) : undefined;
  const files = listFiles(dir);
  const program = readText(join(dir, "agent.ts"));
  return {
    ...payload,
    n,
    seq: frame.seq,
    at: frame.at,
    summary: frame.summary,
    inputsChanged: previous
      ? [
          ...(payload.manifest !== previousPayload.manifest ? ["manifest"] : []),
          ...(payload.grant !== previousPayload.grant ? ["grant"] : []),
          ...(payload.version !== previousPayload.version ? ["endograph"] : []),
        ]
      : ["manifest", "grant", "endograph"],
    resultChanged: compareFiles(previousDir, dir).filter((file) => file.path === "agent.ts" || file.path.startsWith("src/")),
    files,
    shape: programShape(program, files),
    artifacts: {
      ...(readText(join(dir, "manifest.md")) ? { manifest: readText(join(dir, "manifest.md")) } : {}),
      ...(readText(join(dir, "endograph.toml")) ? { grant: readText(join(dir, "endograph.toml")) } : {}),
      ...(program ? { program } : {}),
    },
  };
}

function programShape(program: string | undefined, files: SnapshotFile[]) {
  const source = program ?? "";
  const capture = (pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]!).filter((value, index, all) => all.indexOf(value) === index);
  return {
    nodes: capture(/createNode\s*\(\s*\{[\s\S]*?\bkey\s*:\s*["'`]([^"'`]+)["'`]/g),
    states: capture(/createState\s*\(\s*\{[\s\S]*?\bkey\s*:\s*["'`]([^"'`]+)["'`]/g),
    procedures: files.filter((file) => file.path.startsWith("src/procedures/") && /\.[cm]?[jt]sx?$/.test(file.path)).map((file) => basename(file.path).replace(/\.[^.]+$/, "")),
  };
}

function compareFiles(before: string | undefined, after: string): FileChange[] {
  const prior = new Map(listFiles(before).map((file) => [file.path, file]));
  const next = new Map(listFiles(after).map((file) => [file.path, file]));
  const changes: FileChange[] = [];
  for (const [path] of next) {
    if (!prior.has(path)) changes.push({ path, kind: "added" });
    else if (readText(join(after, path)) !== readText(join(before!, path))) changes.push({ path, kind: "changed" });
  }
  for (const [path] of prior) if (!next.has(path)) changes.push({ path, kind: "removed" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function listFiles(dir: string | undefined): SnapshotFile[] {
  if (!dir || !existsSync(dir)) return [];
  const result: SnapshotFile[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push({ path: relative(dir, path), bytes: stat.size });
    }
  };
  visit(dir);
  return result;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function clippedText(path: string, limit = 50_000): string | undefined {
  const value = readText(path);
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[… ${value.length - limit} more characters]`;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function fileHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}
