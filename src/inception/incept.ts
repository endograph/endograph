import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serializeInstance, type SerializedInstance } from "@projectors/core";
import { grantActions } from "../grant/core.ts";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { isLocked } from "../harness/lock.ts";
import { ensureStateDir, pathsOf, type Paths } from "../harness/paths.ts";
import { loadAgent, LoadError, type Loaded } from "../program/load.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames } from "../store/types.ts";
import { renderEvolution } from "./evolution.ts";
import { openRecord } from "./record.ts";
import { renderWorkspace, writeSnapshot } from "./workspace.ts";

/**
 * Inception: a coding agent writes the program from the owner's inputs,
 * with the agent stopped. Headless (`claude -p` or `codex exec`, or any
 * `--inceptor` command given the prompt as its last argument, run in the
 * agent directory), or by hand: `--manual` renders the workspace and
 * stops, `--accept` validates what the owner's session wrote and records
 * it. Every success is an `inception` frame, a fresh machine snapshot,
 * and a copy of the inputs, the program, and src under snapshots/<n>/.
 * Every attempt, success or not, leaves inceptions/<n>/: the workspace as
 * read and each round's output, writes, and errors (record.ts).
 */

export interface InceptOptions {
  agentDir: string;
  /** The inceptor command; default from the grant, else the first of claude, codex on PATH. */
  inceptor?: string;
  manual?: boolean;
  accept?: boolean;
  log?: (line: string) => void;
}

export interface InceptResult {
  n: number;
  rounds: number;
  workspace: string;
  snapshot: string;
}

export class InceptionFailed extends Error {
  constructor(
    readonly errors: string,
    readonly workspace: string,
    readonly record: string,
  ) {
    super(`inception failed; the workspace is at ${workspace}, the rounds at ${record}:\n${errors}`);
  }
}

const VERSION = (JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;
const PROMPT = "Read .endo/workspace/TASK.md and do exactly what it says.";
const DEFAULT_INCEPTORS = [
  ["claude", "claude -p --dangerously-skip-permissions"],
  ["codex", "codex exec --dangerously-bypass-approvals-and-sandbox"],
] as const;

export async function incept(opts: InceptOptions): Promise<InceptResult | { workspace: string; manual: true }> {
  const log = opts.log ?? (() => {});
  const paths = pathsOf(resolve(opts.agentDir));
  ensureStateDir(paths);
  if (isLocked(paths.lock)) throw new Error(`${paths.agentDir} is running; stop it first (endo down)`);
  const grant = await loadGrant(paths);
  const cwd = resolve(paths.agentDir, grant.cwd);
  const actions = grantActions(grant, { name: grant.name, cwd, charter: notRunning }, { reply: () => "not running" });
  const last = lastInception(paths);
  const n = (last?.n ?? 0) + 1;
  const started = Date.now();
  const inceptor = opts.accept || opts.manual ? "manual" : (opts.inceptor ?? grant.inception.inceptor ?? (await defaultInceptor()));

  if (!opts.accept) {
    const baseline = last ? await baselineOf(paths, grant, actions, cwd, last) : undefined;
    const workspace = renderWorkspace({ paths, grant, actions, n, version: VERSION, baseline });
    log(`workspace rendered at ${workspace} (inception ${n})`);
    if (opts.manual) {
      openRecord(paths, { n, version: VERSION, inceptor });
      return { workspace, manual: true };
    }
  }
  // --accept keeps the record --manual opened, so the workspace as rendered survives.
  const record = openRecord(paths, { n, version: VERSION, inceptor, ...(opts.accept ? {} : { prompt: PROMPT }) }, { keep: opts.accept });

  let rounds = 0;
  let errors: string | null = null;
  if (opts.accept) {
    rounds = 1;
    const t = Date.now();
    errors = await validate(paths, grant, actions, cwd);
    record.round(1, { validateMs: Date.now() - t, errors });
  } else {
    for (rounds = 1; rounds <= grant.inception.rounds; rounds++) {
      log(`inceptor round ${rounds}/${grant.inception.rounds}: ${inceptor}`);
      const prompt = errors ? `${PROMPT} Validation failed; ERRORS.md in the workspace has the stage and the error. Fix the program and src.` : PROMPT;
      const run = await runInceptor(inceptor, prompt, paths.agentDir, log);
      const t = Date.now();
      errors = run.exitCode === 0 ? await validate(paths, grant, actions, cwd) : `inceptor: exited ${run.exitCode}`;
      record.round(rounds, { ...run, validateMs: Date.now() - t, errors });
      if (run.exitCode !== 0) {
        record.close("failed", rounds, errors ?? undefined);
        throw new Error(`inceptor exited ${run.exitCode}; its output is under ${record.dir}`);
      }
      if (!errors) break;
      writeFileSync(join(paths.workspace, "ERRORS.md"), `# ERRORS (round ${rounds})\n\n${errors}\n`);
      log(`validation failed: ${errors.split("\n")[0]}`);
    }
    if (errors) rounds = grant.inception.rounds;
  }
  if (errors) {
    record.close("failed", rounds, errors);
    throw new InceptionFailed(errors, paths.workspace, record.dir);
  }

  // Record: the frame, a fresh machine snapshot (from the edited instance.json when there is one), and the inputs as they stand.
  const store = openSqliteStore(paths.db);
  try {
    const loaded = await loadAgent({ paths, grant, store, actions, cwd, startRun: dryStart, instance: editedInstance(paths) });
    const hashes = { manifest: hashText(grant.manifest.text), grant: hashOf(paths.grant), program: hashOf(paths.program) };
    const changes = existsSync(join(paths.workspace, "CHANGES.md")) ? readFileSync(join(paths.workspace, "CHANGES.md"), "utf8").trim() : undefined;
    store.append({
      type: "inception",
      summary: `inception ${n}${opts.accept ? " (manual)" : ""} after ${rounds} round${rounds === 1 ? "" : "s"}`,
      at: Date.now(),
      payload: { n, ...hashes, version: VERSION, inceptor, rounds, ms: Date.now() - started, ...(changes ? { changes } : {}) },
    });
    store.writeSnapshot({ asOfSeq: store.lastSeq(), at: Date.now(), state: serializeInstance(loaded.machine.instance, loaded.charter) });
  } finally {
    store.close();
  }
  const snapshot = writeSnapshot(paths, grant, n);
  rmSync(join(paths.workspace, "ERRORS.md"), { force: true });
  record.close("recorded", rounds);
  log(`inception ${n} recorded; snapshot at ${snapshot}`);
  return { n, rounds, workspace: paths.workspace, snapshot };
}

/** The load pipeline without an executor, then the commands check. The error text, or null. */
async function validate(paths: Paths, grant: Grant, actions: Loaded["provisions"]["actions"][string][], cwd: string): Promise<string | null> {
  if (!existsSync(paths.program)) return `program: nothing at ${paths.program}`;
  const header = readFileSync(paths.program, "utf8").split("\n").slice(0, 2);
  if (!/^\/\/ \.endo\/program\/agent\.ts — written by inception \d+ \(\d{4}-\d{2}-\d{2}\)\. Do not edit:$/.test(header[0] ?? "") || !/^\/\/ change manifest\.md or endograph\.toml and run `endo incept`\.$/.test(header[1] ?? ""))
    return `program: the two-line header is missing or malformed (PROGRAM.md §2); got:\n${header.join("\n")}`;
  const store = openSqliteStore(paths.db);
  try {
    const loaded = await loadAgent({ paths, grant, store, actions, cwd, startRun: dryStart, instance: editedInstance(paths) });
    if (loaded.failures.length) return loaded.failures.map((f) => `procedures: ${f.name} (${f.file}) failed to describe: ${f.error}`).join("\n");
    return null;
  } catch (err) {
    return err instanceof LoadError ? err.message : `load: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    store.close();
  }
}

const notRunning = () => {
  throw new Error("the agent is not running");
};

const dryStart = () => {
  throw new Error("a procedure cannot run during a dry load");
};

async function runInceptor(command: string, prompt: string, cwd: string, log: (line: string) => void) {
  const started = Date.now();
  const child = Bun.spawn(["sh", "-c", `${command} "$0"`, prompt], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  for (const line of `${stdout}\n${stderr}`.split("\n")) if (line.trim()) log(`  | ${line}`);
  return { stdout, stderr, exitCode, inceptorMs: Date.now() - started };
}

async function defaultInceptor(): Promise<string> {
  for (const [bin, command] of DEFAULT_INCEPTORS) if (Bun.which(bin)) return command;
  throw new Error("no inceptor: install claude or codex, set inception.inceptor in the grant, or pass --inceptor <command>");
}

interface InceptionRecord {
  n: number;
  manifest: string;
  grant: string;
  program: string;
  version: string;
  /** The inception frame's seq: where "since the last inception" starts. */
  seq: number;
}

function lastInception(paths: Paths): InceptionRecord | null {
  if (!existsSync(paths.db)) return null;
  const store = openSqliteStore(paths.db);
  try {
    let last: InceptionRecord | null = null;
    for (const f of allFrames(store)) if (f.type === "inception") last = { ...(f.payload as Omit<InceptionRecord, "seq">), seq: f.seq };
    return last;
  } finally {
    store.close();
  }
}

/** The inceptor's instance.json, when it differs from what the store holds. */
function editedInstance(paths: Paths): SerializedInstance | undefined {
  const file = join(paths.workspace, "instance.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SerializedInstance;
  } catch (err) {
    throw new Error(`workspace/instance.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function baselineOf(paths: Paths, grant: Grant, actions: Loaded["provisions"]["actions"][string][], cwd: string, last: InceptionRecord) {
  const dir = join(paths.snapshots, String(last.n));
  const diffs: string[] = [];
  mkdirSync(paths.workspace, { recursive: true });
  const nowManifest = join(paths.workspace, ".manifest.now");
  writeFileSync(nowManifest, grant.manifest.text);
  for (const [file, now] of [
    ["manifest.md", nowManifest],
    ["endograph.toml", paths.grant],
  ] as const) {
    const then = join(dir, file);
    if (!existsSync(then)) continue;
    const r = Bun.spawnSync(["diff", "-u", "--label", `${file} (inception ${last.n})`, "--label", `${file} (now)`, then, now], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 1) diffs.push(r.stdout.toString());
  }
  rmSync(nowManifest, { force: true });
  if (last.version !== VERSION) diffs.push(`endograph ${last.version} -> ${VERSION}\n`);
  const errors = existsSync(paths.program) ? await validate(paths, grant, actions, cwd) : `program: nothing at ${paths.program}`;
  const store = openSqliteStore(paths.db);
  const instance = store.readSnapshot()?.state;
  const evolution = renderEvolution(store, last.seq, last.n);
  store.close();
  return { dir, diff: diffs.join("\n"), errors: errors ?? undefined, instance, evolution };
}

export interface InceptionStatus {
  /** The last inception's number; 0 before the first. */
  n: number;
  /** Owner inputs that differ from the last inception: "manifest", "grant", "endograph". */
  changed: string[];
  /** program/agent.ts differs from what the last inception recorded. */
  programEdited: boolean;
  /** Why the program does not load, when `load` was asked for. */
  loadError: string | null;
}

/** Inputs versus the last inception, for `endo status` and `endo doctor`. */
export async function inceptionStatus(paths: Paths, opts: { load?: boolean } = {}): Promise<InceptionStatus> {
  const last = lastInception(paths);
  if (!last) return { n: 0, changed: [], programEdited: false, loadError: null };
  const grant = await loadGrant(paths);
  const changed: string[] = [];
  if (hashText(grant.manifest.text) !== last.manifest) changed.push("manifest");
  if (hashOf(paths.grant) !== last.grant) changed.push("grant");
  if (VERSION !== last.version) changed.push("endograph");
  const programEdited = existsSync(paths.program) && hashOf(paths.program) !== last.program;
  let loadError: string | null = null;
  if (opts.load !== false) {
    const cwd = resolve(paths.agentDir, grant.cwd);
    const actions = grantActions(grant, { name: grant.name, cwd, charter: notRunning }, { reply: () => "not running" });
    loadError = await validate(paths, grant, actions, cwd);
  }
  return { n: last.n, changed, programEdited, loadError };
}

export function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

