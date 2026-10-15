import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite } from "../protocol/wire.ts";
import { serializeInstance, type SerializedInstance } from "@projectors/core";
import { grantActions } from "../grant/core.ts";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { bindRuntime } from "../grant/bind.ts";
import type { HostClient } from "../host/client.ts";
import { acquireLock } from "../harness/lock.ts";
import { canonical, ensureStateDir, pathsOf, type Paths } from "../harness/paths.ts";
import { loadAgent, LoadError } from "../program/load.ts";
import type { DescribeFailure } from "../procedures/describe.ts";
import { hasPersistedStore, openSqliteStore } from "../store/sqlite.ts";
import { allFrames } from "../store/types.ts";
import { protectInceptor } from "./sandbox.ts";
import { readEnv } from "../harness/env.ts";
import { promote, recoverPromotion } from "./promotion.ts";
import { renderEvolution } from "./evolution.ts";
import { openRecord } from "./record.ts";
import { describeGrant, renderGrant, renderWorkspace, writeSnapshot } from "./workspace.ts";
import { harnessOrder, HEADLESS, type NativeConversation, type NativeSession } from "./harnesses.ts";

/**
 * Inception: a coding agent writes the program from the owner's inputs,
 * with the agent stopped. Headless (`codex exec`, `claude -p`, or any
 * `--inceptor` command given the prompt as its last argument, run in the
 * agent directory), interactively through an owner editor callback, or by hand:
 * `--manual` renders the workspace and
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
  /** The inceptor command; default from the grant, else the preferred installed harness. */
  inceptor?: string;
  /** Owner-driven editing of the staged candidate; returns only after an explicit finish handoff. */
  interactive?: InteractiveInceptor;
  /** Optional prior conversation for the first inception only; pending sessions take precedence. */
  initialSession?: NativeSession;
  manual?: boolean;
  accept?: boolean;
  log?: (line: string) => void;
  /** Load generated code in an isolated runtime, rather than this inceptor process. */
  loadRuntime?: RuntimeLoader;
}

export interface InteractiveInceptionSession extends NativeConversation {
  directory: string;
  instructions: string;
}
export type InteractiveInceptor = (session: InteractiveInceptionSession) => Promise<void>;

interface InteractiveState {
  version: 1;
  n: number;
  source: string;
  rounds: number;
  native?: NativeSession;
}
const interactiveFile = (paths: Paths) => join(paths.local, "inception", "session.json");
export const hasInteractiveInception = (paths: Paths) => existsSync(interactiveFile(paths));

export interface RuntimeLoadInput {
  /** Candidate program/procedures and live store paths. */
  paths: Paths;
  /** Original owner grant/executor locations, even when paths points at a candidate. */
  ownerPaths: Paths;
  cwd: string;
  /** Host-parsed final owner inputs for this validation; never supplied by generated code. */
  grant?: Grant;
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

export async function incept(opts: InceptOptions): Promise<InceptResult | { workspace: string; manual: true }> {
  if (opts.interactive && (opts.manual || opts.accept || opts.inceptor))
    throw new Error("interactive inception cannot be combined with manual, accept, or a custom inceptor");
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
  let finalGrant = grant;
  const grantHash = hashOf(paths.grant);
  const last = lastInception(paths);
  const n = (last?.n ?? 0) + 1;
  const started = Date.now();
  const inceptor = opts.interactive ? "interactive" : opts.accept || opts.manual ? "manual" : (opts.inceptor ?? grant.inception.inceptor ?? (await defaultInceptor()));

  const stateFile = interactiveFile(paths);
  const source = opts.interactive ? interactiveSource(paths, grant) : undefined;
  let session = opts.accept ? undefined : resumableDraft(paths, n, source, log);
  if (!opts.accept && !session) {
    const baseline = last ? await baselineOf(paths, grant, last, opts.loadRuntime) : undefined;
    const workspace = renderWorkspace({ paths, grant, description: describeGrant(paths, grant), n, version: VERSION, baseline });
    log(`workspace rendered at ${workspace} (inception ${n})`);
    const candidate = prepareCandidate(paths);
    writeFileSync(join(candidate.agentDir, "manifest.md"), grant.manifest.text);
    if (opts.manual) {
      openRecord({ ...candidate, inceptions: paths.inceptions }, { n, version: VERSION, inceptor });
      return { workspace: candidate.workspace, manual: true };
    }
  }
  const resumed = !!session;
  if (opts.interactive && !session) {
    session = { version: 1, n, source: source!, rounds: 0, ...(n === 1 && opts.initialSession ? { native: opts.initialSession } : {}) };
    saveInteractive(stateFile, session);
  }
  const candidate = candidatePaths(paths);
  if (!existsSync(candidate.workspace)) throw new Error("no staged inception; run endo incept --manual first");
  // Validate against live state and runtime cwd, while importing only candidate code.
  const candidateMatches = () => existsSync(candidate.grant) && hashOf(candidate.grant) === grantHash &&
    existsSync(join(candidate.workspace, "MANIFEST.md")) && readFileSync(join(candidate.workspace, "MANIFEST.md"), "utf8") === grant.manifest.text;
  if (!opts.interactive && !candidateMatches())
    throw new Error("owner inputs changed since the candidate was prepared; start a new inception");
  const staged = { ...candidate, db: paths.db, snapshots: paths.snapshots, inceptions: paths.inceptions };
  // --accept keeps the record --manual opened, so the workspace as rendered survives.
  const record = openRecord(staged, { n, version: VERSION, inceptor, ...(opts.accept ? {} : { prompt: PROMPT }) }, { keep: opts.accept || resumed });

  let rounds = session?.rounds ?? 0;
  let attempts = 0;
  let state: SerializedInstance;
  let manifestTargetBefore: string | undefined;
  let finalConfig = readFileSync(candidate.grant, "utf8");
  const maxRounds = opts.accept ? 1 : grant.inception.rounds;
  for (;;) {
    rounds++;
    attempts++;
    let run: Awaited<ReturnType<typeof runInceptor>> | undefined;
    if (!opts.accept) {
      log(`inceptor round ${attempts}/${grant.inception.rounds}: ${inceptor}`);
      const prompt = existsSync(join(candidate.workspace, "ERRORS.md"))
        ? `${PROMPT} Validation failed; ERRORS.md in the workspace has the stage and the error. Fix the program and src.` : PROMPT;
      if (opts.interactive && session) {
        const t = Date.now();
        try {
          await opts.interactive({
            directory: candidate.agentDir,
            instructions: `${prompt}\nThis is interactive inception ${n}. Collaborate with the owner on the program in this staged candidate.\nIf this conversation previously configured owner files, that setup phase is complete. Its editing restrictions and draft paths no longer apply. Use the current candidate directory and TASK.md: now build the program and procedures.\nThe staged manifest.md and endograph.toml are off limits unless the owner explicitly requests a change. Only then edit those staged files (inline manifests are edited in the config), and adapt the program to the requested inputs. This interactive instruction overrides TASK.md's general prohibition. Never edit live owner files. Endograph validates and publishes the final inputs with the program. Workspace MANIFEST.md and GRANT.md describe the previous inputs and may be stale after your edits.\nPreserve the program contract, and the agent's existing work and instance migration.\nEndograph holds the agent lock and will validate and promote the candidate after you finish. Do not run endo up or another inception.`,
            previous: session.native,
            save(native) { session!.native = native; saveInteractive(stateFile, session!); },
          });
          run = { exitCode: 0, stdout: "", stderr: "", inceptorMs: Date.now() - t };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record.round(rounds, { native: session.native, validateMs: 0, inceptorMs: Date.now() - t, errors: `interactive: ${message}` });
          session.rounds = rounds;
          saveInteractive(stateFile, session);
          throw new Error(`${message}. Candidate preserved; resume with endo incept --interactive --agent ${JSON.stringify(paths.agentDir)}`);
        }
      } else run = await runInceptor(inceptor, prompt, candidate.agentDir, log, paths, grant);
    }
    const t = Date.now();
    let result: Validation;
    try {
      if (opts.interactive) {
        finalConfig = readFileSync(candidate.grant, "utf8");
        finalGrant = await loadGrant(paths, {
          config: finalConfig,
          manifest: readFileSync(join(candidate.agentDir, "manifest.md"), "utf8"),
        });
        if (finalGrant.manifest.path) {
          const target = canonical(finalGrant.manifest.path);
          if (target === canonical(paths.grant) || target === canonical(paths.env) || target.startsWith(canonical(paths.state) + "/"))
            throw new Error("manifest must be an owner file separate from endograph.toml, .env, and .endo state");
          // A relocated manifest carries the staged text to its new path; it never replaces an unrelated file.
          if (target !== (grant.manifest.path && canonical(grant.manifest.path)) && existsSync(target) && readFileSync(target, "utf8") !== finalGrant.manifest.text)
            throw new Error(`manifest = ${JSON.stringify(finalGrant.manifest.path)} would overwrite an existing file; choose a new path, or copy the manifest there first`);
        }
        manifestTargetBefore = finalGrant.manifest.path && existsSync(finalGrant.manifest.path)
          ? readFileSync(finalGrant.manifest.path, "utf8") : undefined;
        writeFileSync(join(candidate.workspace, "MANIFEST.md"), finalGrant.manifest.text);
        writeFileSync(join(candidate.agentDir, "manifest.md"), finalGrant.manifest.text);
        const description = describeGrant(paths, finalGrant);
        writeFileSync(join(candidate.workspace, "GRANT.md"), renderGrant({ paths, grant: finalGrant, description, n, version: VERSION }));
        for (const battery of description.batteries)
          writeFileSync(join(candidate.workspace, "batteries", `${battery.name}.md`), battery.guide);
      } else if (!candidateMatches() || readFileSync(join(candidate.agentDir, "manifest.md"), "utf8") !== grant.manifest.text) {
        throw new Error("owner inputs changed during non-interactive inception");
      }
      result = run && run.exitCode !== 0
        ? { ok: false, error: `inceptor: exited ${run.exitCode}` }
        : await validateProgram({ paths: staged, ownerPaths: paths, grant: finalGrant, candidate: true, loadRuntime: opts.loadRuntime });
    } catch (error) { result = { ok: false, error: `owner inputs: ${error instanceof Error ? error.message : String(error)}` }; }
    record.round(rounds, { ...run, ...(session?.native ? { native: session.native } : {}), validateMs: Date.now() - t, errors: result.ok ? null : result.error });
    if (session) { session.rounds = rounds; saveInteractive(stateFile, session); }
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
    if (attempts === maxRounds) {
      if (!opts.interactive) record.close("failed", rounds, result.error);
      throw new InceptionFailed(result.error, candidate.workspace, record.dir);
    }
  }

  // Promote only what was validated, against the inputs it was validated with, without invoking
  // generated code again. An interactive session stays resumable unless live agent work moved underneath it.
  const stale = !!session && interactiveSource(paths, await loadGrant(paths)) !== session.source;
  const changed = stale ? "owner inputs or agent state changed during interactive inception; rerun --interactive to prepare a fresh candidate"
    : hashOf(paths.grant) !== grantHash || (await loadGrant(paths)).manifest.text !== grant.manifest.text ? "owner inputs changed during inception; retry against the current inputs"
    : readFileSync(candidate.grant, "utf8") !== finalConfig ? "staged config changed during validation; retry inception"
    : opts.interactive && finalGrant.manifest.path && (existsSync(finalGrant.manifest.path) ? readFileSync(finalGrant.manifest.path, "utf8") : undefined) !== manifestTargetBefore
      ? "manifest destination changed during validation; retry inception"
    : undefined;
  if (changed) {
    if (stale || !opts.interactive) record.close("failed", rounds, changed);
    throw new Error(changed);
  }
  const hashes = { manifest: hashText(finalGrant.manifest.text), grant: hashOf(candidate.grant), program: hashOf(candidate.program) };
  const changes = existsSync(join(candidate.workspace, "CHANGES.md")) ? readFileSync(join(candidate.workspace, "CHANGES.md"), "utf8").trim() : undefined;
  const snapshot = writeSnapshot(staged, finalGrant, n, state);
  try {
    promote(paths, candidate, n, {
      type: "inception",
      summary: `inception ${n}${opts.interactive ? " (interactive)" : opts.accept ? " (manual)" : opts.trigger === "auto" ? " (auto)" : ""} after ${rounds} round${rounds === 1 ? "" : "s"}`,
      at: Date.now(),
      payload: { n, ...hashes, version: VERSION, inceptor, rounds, trigger: opts.trigger ?? "owner", ms: Date.now() - started, ...(changes ? { changes } : {}) },
    }, { at: Date.now(), state }, opts.interactive ? [
      { path: paths.grant, contents: finalConfig },
      ...(finalGrant.manifest.path ? [{ path: finalGrant.manifest.path, contents: finalGrant.manifest.text }] : []),
    ] : []);
  } catch (err) {
    record.close("failed", rounds, err instanceof Error ? err.message : String(err));
    throw err;
  }
  rmSync(join(candidate.workspace, "ERRORS.md"), { force: true });
  rmSync(paths.workspace, { recursive: true, force: true });
  cpSync(candidate.workspace, paths.workspace, { recursive: true });
  record.close("recorded", rounds);
  if (session) {
    renameSync(stateFile, join(dirname(stateFile), `completed-${n}.json`));
  } else rmSync(stateFile, { force: true });
  log(`inception ${n} recorded; snapshot at ${snapshot}`);
  return { n, rounds, workspace: paths.workspace, snapshot };
}

/** A saved interactive draft resumes only into the same interactive inception; anything else archives it. */
function resumableDraft(paths: Paths, n: number, source: string | undefined, log: (line: string) => void): InteractiveState | undefined {
  const stateFile = interactiveFile(paths);
  if (!existsSync(stateFile)) return undefined;
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as InteractiveState;
  if (source && saved.version === 1 && saved.n === n && saved.source === source && existsSync(candidatePaths(paths).workspace)) {
    log(`resuming interactive inception ${n}`);
    return saved;
  }
  // Retain the draft, but never migrate stale runtime state over newer agent work.
  const archive = join(paths.local, "inception", `previous-${Date.now()}`);
  mkdirSync(archive, { recursive: true });
  if (existsSync(candidatePaths(paths).agentDir)) renameSync(candidatePaths(paths).agentDir, join(archive, "candidate"));
  renameSync(stateFile, join(archive, "session.json"));
  log(`${source ? "owner inputs or agent state changed" : "a non-interactive inception replaces the interactive draft"}; previous draft preserved at ${archive}`);
  return undefined;
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
      paths, ownerPaths, grant, cwd: resolve(ownerPaths.agentDir, grant.cwd),
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
  const grant = input.grant ?? await loadGrant(input.ownerPaths);
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

async function runInceptor(command: string, prompt: string, cwd: string, log: (line: string) => void, paths: Paths, grant: Grant) {
  const started = Date.now();
  const wrapped = protectInceptor(paths, grant, cwd, ["/bin/sh", "-c", `${command} "$0"`, prompt]);
  // The agent's credentials are not the author's: it authenticates with its own CLI login.
  const env: NodeJS.ProcessEnv = { ...process.env, ...wrapped.env, FORCE_COLOR: "0" };
  for (const [key] of readEnv(paths)) delete env[key];
  const child = Bun.spawn(wrapped.argv, { cwd, stdout: "pipe", stderr: "pipe", env });
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
  for (const harness of harnessOrder()) if (Bun.which(harness)) return HEADLESS[harness];
  throw new Error("no inceptor: install codex or claude, set inception.inceptor in the grant, or pass --inceptor <command>");
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

/** Durable identity and progress, separate from the agent's runtime state and snapshots. */
const saveInteractive = (file: string, session: InteractiveState) => atomicWrite(dirname(file), basename(file), session);

/** Fence a resumed draft against intervening activations or changes to the agent's own code. */
function interactiveSource(paths: Paths, grant: Grant): string {
  const hash = createHash("sha256").update(VERSION).update(readFileSync(paths.grant)).update(grant.manifest.text);
  const tree = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      hash.update(file.slice(paths.agentDir.length));
      if (entry.isDirectory()) tree(file);
      else if (entry.isSymbolicLink()) hash.update(readlinkSync(file));
      else if (entry.isFile()) hash.update(readFileSync(file));
    }
  };
  tree(dirname(paths.program));
  tree(paths.src);
  let seq = 0;
  if (hasPersistedStore(paths.db)) {
    const store = openSqliteStore(paths.db);
    try { seq = store.lastSeq(); } finally { store.close(); }
  }
  hash.update(String(seq));
  return hash.digest("hex");
}
