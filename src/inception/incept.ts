import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serializeInstance, type SerializedInstance } from "@projectors/core";
import { grantActions } from "../grant/core.ts";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { bindRuntime } from "../grant/bind.ts";
import type { HostClient } from "../host/client.ts";
import { acquireLock } from "../harness/lock.ts";
import { ensureStateDir, pathsOf, type Paths } from "../harness/paths.ts";
import { loadAgent, LoadError } from "../program/load.ts";
import type { DescribeFailure } from "../procedures/describe.ts";
import { hasPersistedStore, openSqliteStore } from "../store/sqlite.ts";
import { allFrames } from "../store/types.ts";
import { promote, recoverPromotion } from "./promotion.ts";
import { renderEvolution } from "./evolution.ts";
import { openRecord } from "./record.ts";
import { describeGrant, renderWorkspace, writeSnapshot } from "./workspace.ts";

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
  /** The caller (the running harness) already holds the lock. */
  lock?: "held";
  /** What set this inception off; recorded in the frame. Default "owner" (`endo incept`, or `endo up` with no loadable program). */
  trigger?: "owner" | "auto";
  agentDir: string;
  /** The inceptor command; default from the grant, else the first of claude, codex on PATH. */
  inceptor?: string;
  manual?: boolean;
  accept?: boolean;
  log?: (line: string) => void;
  /** Load generated code in an isolated runtime, rather than this inceptor process. */
  loadRuntime?: RuntimeLoader;
}

export interface RuntimeLoadInput {
  /** Candidate program/procedures and live store paths. */
  paths: Paths;
  /** Original owner grant/executor locations, even when paths points at a candidate. */
  ownerPaths: Paths;
  cwd: string;
  instance?: SerializedInstance;
}
export interface RuntimeLoadResult {
  state: SerializedInstance;
  failures: DescribeFailure[];
}
export type RuntimeLoader = (input: RuntimeLoadInput) => Promise<RuntimeLoadResult>;

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
  const paths = pathsOf(resolve(opts.agentDir));
  ensureStateDir(paths);
  // Inception owns the state directory while it runs: the harness's own lock, so no `endo up` loads a
  // half-written program and no second inception races this one. A manual inception releases it at
  // once; its open record (inceptions/<n>/inception.json without `finished`) is what marks it open.
  if (opts.lock === "held") return inceptHolding(paths, opts);
  const lock = acquireLock(paths.lock);
  if (!lock) {
    const open = openInception(paths);
    if (open) throw new Error(`inception ${open.n} is already running in ${paths.agentDir} (since ${open.started})`);
    const auto = await loadGrant(paths).then((g) => g.inception.mode === "auto", () => false);
    throw new Error(`${paths.agentDir} is running; stop it first (endo down)${auto ? ", or leave it: in auto mode it incepts by itself once idle" : ""}`);
  }
  try {
    return await inceptHolding(paths, opts);
  } finally {
    lock.release();
  }
}

async function inceptHolding(paths: Paths, opts: InceptOptions): Promise<InceptResult | { workspace: string; manual: true }> {
  recoverPromotion(paths);
  const log = opts.log ?? (() => {});
  const grant = await loadGrant(paths);
  const grantHash = hashOf(paths.grant);
  const last = lastInception(paths);
  const n = (last?.n ?? 0) + 1;
  const started = Date.now();
  const inceptor = opts.accept || opts.manual ? "manual" : (opts.inceptor ?? grant.inception.inceptor ?? (await defaultInceptor()));

  if (!opts.accept) {
    const baseline = last ? await baselineOf(paths, grant, last, opts.loadRuntime) : undefined;
    const workspace = renderWorkspace({ paths, grant, description: describeGrant(paths, grant), n, version: VERSION, baseline });
    log(`workspace rendered at ${workspace} (inception ${n})`);
    const candidate = prepareCandidate(paths);
    if (opts.manual) {
      openRecord({ ...candidate, inceptions: paths.inceptions }, { n, version: VERSION, inceptor });
      return { workspace: candidate.workspace, manual: true };
    }
  }
  const candidate = candidatePaths(paths);
  if (!existsSync(candidate.workspace)) throw new Error("no staged inception; run endo incept --manual first");
  // Validate against live state and runtime cwd, while importing only candidate code.
  if (hashOf(candidate.grant) !== grantHash || readFileSync(join(candidate.workspace, "MANIFEST.md"), "utf8") !== grant.manifest.text)
    throw new Error("owner inputs changed since the candidate was prepared; start a new inception");
  const staged = { ...candidate, db: paths.db, snapshots: paths.snapshots, inceptions: paths.inceptions };
  // --accept keeps the record --manual opened, so the workspace as rendered survives.
  const record = openRecord(staged, { n, version: VERSION, inceptor, ...(opts.accept ? {} : { prompt: PROMPT }) }, { keep: opts.accept });

  let rounds = 0;
  let state: SerializedInstance;
  const maxRounds = opts.accept ? 1 : grant.inception.rounds;
  for (;;) {
    rounds++;
    let run: Awaited<ReturnType<typeof runInceptor>> | undefined;
    if (!opts.accept) {
      log(`inceptor round ${rounds}/${grant.inception.rounds}: ${inceptor}`);
      const prompt = rounds > 1 ? `${PROMPT} Validation failed; ERRORS.md in the workspace has the stage and the error. Fix the program and src.` : PROMPT;
      run = await runInceptor(inceptor, prompt, candidate.agentDir, log);
    }
    const t = Date.now();
    const result: Validation = run && run.exitCode !== 0
      ? { ok: false, error: `inceptor: exited ${run.exitCode}` }
      : await validateProgram({ paths: staged, ownerPaths: paths, grant, candidate: true, loadRuntime: opts.loadRuntime });
    record.round(rounds, { ...run, validateMs: Date.now() - t, errors: result.ok ? null : result.error });
    if (result.ok) {
      state = result.state;
      break;
    }
    if (run && run.exitCode !== 0) {
      record.close("failed", rounds, result.error);
      throw new Error(`inceptor exited ${run.exitCode}; its output is under ${record.dir}`);
    }
    if (!opts.accept) {
      writeFileSync(join(candidate.workspace, "ERRORS.md"), `# ERRORS (round ${rounds})\n\n${result.error}\n`);
      log(`validation failed: ${result.error.split("\n")[0]}`);
    }
    if (rounds === maxRounds) {
      record.close("failed", rounds, result.error);
      throw new InceptionFailed(result.error, candidate.workspace, record.dir);
    }
  }

  // Promote the instance from the successful validation, without invoking generated code again.
  if (hashOf(paths.grant) !== grantHash || hashOf(candidate.grant) !== grantHash || (await loadGrant(paths)).manifest.text !== grant.manifest.text) {
    record.close("failed", rounds, "owner inputs changed during inception");
    throw new Error("owner inputs changed during inception; retry against the current inputs");
  }
  const hashes = { manifest: hashText(grant.manifest.text), grant: hashOf(paths.grant), program: hashOf(candidate.program) };
  const changes = existsSync(join(candidate.workspace, "CHANGES.md")) ? readFileSync(join(candidate.workspace, "CHANGES.md"), "utf8").trim() : undefined;
  const snapshot = writeSnapshot(staged, grant, n, state);
  try {
    promote(paths, candidate, n, {
      type: "inception",
      summary: `inception ${n}${opts.accept ? " (manual)" : opts.trigger === "auto" ? " (auto)" : ""} after ${rounds} round${rounds === 1 ? "" : "s"}`,
      at: Date.now(),
      payload: { n, ...hashes, version: VERSION, inceptor, rounds, trigger: opts.trigger ?? "owner", ms: Date.now() - started, ...(changes ? { changes } : {}) },
    }, { at: Date.now(), state });
  } catch (err) {
    record.close("failed", rounds, err instanceof Error ? err.message : String(err));
    throw err;
  }
  rmSync(join(candidate.workspace, "ERRORS.md"), { force: true });
  rmSync(paths.workspace, { recursive: true, force: true });
  cpSync(candidate.workspace, paths.workspace, { recursive: true });
  record.close("recorded", rounds);
  log(`inception ${n} recorded; snapshot at ${snapshot}`);
  return { n, rounds, workspace: paths.workspace, snapshot };
}

function candidatePaths(paths: Paths): Paths {
  return pathsOf(join(paths.state, "candidate"));
}

/** An agent-shaped work area: failed and manual edits never touch the active program or src. */
function prepareCandidate(paths: Paths): Paths {
  const candidate = candidatePaths(paths);
  rmSync(candidate.agentDir, { recursive: true, force: true });
  ensureStateDir(candidate);
  cpSync(paths.grant, candidate.grant);
  for (const [source, target] of [[dirname(paths.program), dirname(candidate.program)], [paths.src, candidate.src], [paths.workspace, candidate.workspace]]) {
    if (existsSync(source!)) cpSync(source!, target!, { recursive: true });
  }
  // The grant/workspace carry the resolved inputs. Runtime state stays outside the work area.
  return candidate;
}

export type Validation = { ok: true; state: SerializedInstance } | { ok: false; error: string };

/** One dry load checks the program and procedures and supplies the instance to promote. */
export async function validateProgram(opts: {
  paths: Paths;
  grant: Grant;
  ownerPaths?: Paths;
  candidate?: boolean;
  loadRuntime?: RuntimeLoader;
}): Promise<Validation> {
  const { paths, grant, ownerPaths = paths } = opts;
  if (!existsSync(paths.program)) return { ok: false, error: `program: nothing at ${paths.program}` };
  const header = readFileSync(paths.program, "utf8").split("\n").slice(0, 2);
  if (!/^\/\/ \.endo\/program\/agent\.ts — written by inception \d+ \(\d{4}-\d{2}-\d{2}\)\. Do not edit:$/.test(header[0] ?? "") || !/^\/\/ change manifest\.md or endograph\.toml and run `endo incept`\.$/.test(header[1] ?? ""))
    return { ok: false, error: `program: the two-line header is missing or malformed (PROGRAM.md §2); got:\n${header.join("\n")}` };
  try {
    const loaded = await runtimeLoad({
      paths, ownerPaths, cwd: resolve(ownerPaths.agentDir, grant.cwd),
      instance: opts.candidate ? editedInstance(paths) : undefined,
    }, grant, opts.loadRuntime);
    if (loaded.failures.length) return { ok: false, error: loaded.failures.map((f) => `procedures: ${f.name} (${f.file}) failed to describe: ${f.error}`).join("\n") };
    return { ok: true, state: loaded.state };
  } catch (err) {
    return { ok: false, error: err instanceof LoadError ? err.message : `load: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Entry point for the sandbox worker. The caller must establish its process
 * boundary before calling this function: it imports generated agent code. */
export async function loadInceptionRuntime(input: RuntimeLoadInput, host?: HostClient): Promise<RuntimeLoadResult> {
  const grant = await loadGrant(input.ownerPaths);
  const bindings = await bindRuntime(input.ownerPaths, grant, host);
  const actions = grantActions(bindings, { name: grant.name, cwd: input.cwd, charter: notRunning }, { reply: () => "not running" });
  const store = openSqliteStore(input.paths.db);
  try {
    const loaded = await loadAgent({ ...input, grant, bindings, store, actions, startRun: dryStart });
    return { state: serializeInstance(loaded.machine.instance, loaded.charter), failures: loaded.failures };
  } finally { store.close(); }
}

async function runtimeLoad(input: RuntimeLoadInput, grant: Grant, loader?: RuntimeLoader): Promise<RuntimeLoadResult> {
  if (loader) return loader(input);
  if (grant.sandbox) throw new Error("sandboxed inception validation requires an isolated runtime loader");
  return loadInceptionRuntime(input);
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
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let output = "";
    let pending = "";
    const append = (text: string) => {
      output += text;
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) log(`  | ${line}`);
      }
    };
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
    append(decoder.decode());
    if (pending.trim()) log(`  | ${pending}`);
    return output;
  };
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
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
  if (!hasPersistedStore(paths.db)) return null;
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

async function baselineOf(paths: Paths, grant: Grant, last: InceptionRecord, loadRuntime?: RuntimeLoader) {
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
  const validation = await validateProgram({ paths, grant, loadRuntime });
  const store = openSqliteStore(paths.db);
  const instance = store.readSnapshot()?.state;
  const evolution = renderEvolution(store, last.seq, last.n);
  store.close();
  return { dir, diff: diffs.join("\n"), errors: validation.ok ? undefined : validation.error, instance, evolution };
}

/** An inception opened and not closed: running now (it holds the lock), waiting for `--accept` (manual), or interrupted. */
export function openInception(paths: Paths): { n: number; inceptor: string; started: string } | null {
  if (!existsSync(paths.inceptions)) return null;
  const n = Math.max(0, ...readdirSync(paths.inceptions).map(Number).filter(Number.isInteger));
  if (!n) return null;
  try {
    const meta = JSON.parse(readFileSync(join(paths.inceptions, String(n), "inception.json"), "utf8")) as { inceptor: string; started: string; finished?: string };
    return meta.finished ? null : { n, inceptor: meta.inceptor, started: meta.started };
  } catch {
    return null;
  }
}

export interface InceptionStatus {
  /** The last inception's number; 0 before the first. */
  n: number;
  /** Owner inputs that differ from the last inception: "manifest", "grant", "endograph". */
  changed: string[];
  /** program/agent.ts differs from what the last inception recorded. */
  programEdited: boolean;
  /** The owner's inputs as they stand, in one string: equal when nothing moved. */
  inputs: string;
}

/** Compare owner inputs with the last inception. Never loads generated code. */
export async function inceptionStatus(paths: Paths): Promise<InceptionStatus> {
  const last = lastInception(paths);
  const grant = await loadGrant(paths);
  const manifestHash = hashText(grant.manifest.text);
  const grantHash = hashOf(paths.grant);
  const inputs = `${manifestHash} ${grantHash} ${VERSION}`;
  const changed: string[] = [];
  if (last && manifestHash !== last.manifest) changed.push("manifest");
  if (last && grantHash !== last.grant) changed.push("grant");
  if (last && VERSION !== last.version) changed.push("endograph");
  const programEdited = !!last && existsSync(paths.program) && hashOf(paths.program) !== last.program;
  return { n: last?.n ?? 0, changed, programEdited, inputs };
}

export function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
