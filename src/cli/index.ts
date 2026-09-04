#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { openAgent, AlreadyRunning, NoProgram } from "../harness/agent.ts";
import { isLocked } from "../harness/lock.ts";
import { pathsOf } from "../harness/paths.ts";
import { incept, InceptionFailed } from "../inception/incept.ts";
import { newId, PROTOCOL_VERSION, waitForReply, writeMessage } from "../protocol/wire.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames } from "../store/types.ts";
import { framesAbout, printFrame } from "./frames.ts";
import { claim, list, lookup, NameConflict, release, resolveAgent } from "./registry.ts";
import { installService, removeService, serviceInfo, serviceRunning } from "./service.ts";
import { fromTemplate, interactiveSetup } from "./setup.ts";
import { USAGE } from "./usage.ts";

interface Flags {
  agent?: string;
  inceptor?: string;
  manual: boolean;
  accept: boolean;
  wait: boolean;
  follow: boolean;
  foreground: boolean;
  service: boolean;
  force: boolean;
  template?: string;
  id?: string;
  ref?: string;
  rest: string[];
}

function parse(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = { manual: false, accept: false, wait: false, follow: false, foreground: false, service: false, force: false, rest: [] };
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agent") flags.agent = argv[++i];
    else if (a === "--inceptor") flags.inceptor = argv[++i];
    else if (a === "--manual") flags.manual = true;
    else if (a === "--accept") flags.accept = true;
    else if (a === "--wait") flags.wait = true;
    else if (a === "-f" || a === "--follow") flags.follow = true;
    else if (a === "--foreground") flags.foreground = true;
    else if (a === "--service") flags.service = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--template") flags.template = argv[++i];
    else if (a === "--id") flags.id = argv[++i];
    else if (a === "--ref") flags.ref = argv[++i];
    else if (!command) command = a;
    else flags.rest.push(a);
  }
  return { command, flags };
}

const say = (line: string) => console.log(line);
const notRunning = () => {
  throw new Error("the agent is not running");
};

/** The agent directory a command targets: `--agent`, else the current directory. It must hold a grant. */
function target(flags: Flags): ReturnType<typeof pathsOf> | null {
  const dir = flags.agent ? resolveAgent(flags.agent) : existsSync(resolve("endograph.ts")) ? process.cwd() : null;
  if (dir) return pathsOf(dir);
  console.error(flags.agent ? `no agent "${flags.agent}": not a registered name and no endograph.ts at that path` : `no endograph.ts in ${process.cwd()}; run in the agent directory or pass --agent <name|dir>`);
  return null;
}

/** Load the grant once to learn the name (claiming the registry needs it before the harness runs). */
async function agentName(paths: ReturnType<typeof pathsOf>): Promise<string> {
  const { importGrant } = await import("../harness/agent.ts");
  const { ensureStateDir } = await import("../harness/paths.ts");
  ensureStateDir(paths);
  return (await importGrant(paths)).name;
}

async function up(flags: Flags): Promise<number> {
  if (!flags.agent && !existsSync(resolve("endograph.ts"))) {
    if (flags.template) {
      const err = fromTemplate(process.cwd(), flags.template);
      if (err) {
        console.error(err);
        return 1;
      }
      say(`endograph.ts and manifest.md copied from ${flags.template}`);
    } else if (flags.service) {
      console.error(`no endograph.ts in ${process.cwd()}`);
      return 0;
    } else {
      say(`no endograph.ts in ${process.cwd()}: setting up a new agent here`);
      await interactiveSetup(process.cwd(), async (q, fallback) => {
        const answer = (prompt(`${q}${fallback ? ` [${fallback}]` : ""}:`) ?? "").trim();
        return answer || fallback || "";
      });
      say("wrote endograph.ts and manifest.md; edit manifest.md before inception if the stub is not enough");
    }
  }
  const paths = target(flags);
  if (!paths) return 1;
  let name: string;
  try {
    name = await agentName(paths);
    claim(name, paths.agentDir);
  } catch (err) {
    console.error(err instanceof NameConflict ? err.message : `cannot load ${paths.grant}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!existsSync(paths.program)) {
    if (flags.service) {
      console.error("no program; run `endo up` in a terminal so inception can run");
      return 0;
    }
    say("no program: running inception 1");
    try {
      await incept({ agentDir: paths.agentDir, inceptor: flags.inceptor, log: say });
    } catch (err) {
      console.error(err instanceof InceptionFailed ? err.message : `inception failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (!flags.foreground && !flags.service) {
    if (isLocked(paths.lock) && !(await serviceRunning(name).catch(() => false))) {
      console.error(`${name} is running in the foreground somewhere; stop it first`);
      return 1;
    }
    try {
      await installService(name, paths.agentDir);
    } catch (err) {
      console.error(`could not install the service: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    say(`${name} is up under ${process.platform === "darwin" ? "launchd" : "systemd"} from ${paths.agentDir}: now, at every login, after crashes`);
    say(`  endo --agent ${name} status | endo logs -f | endo down`);
    return 0;
  }
  if (flags.foreground && (await serviceRunning(name).catch(() => false))) {
    console.error(`${name} is running as a service; \`endo down\` first, or watch it with \`endo logs -f\``);
    return 1;
  }
  try {
    const agent = await openAgent({ agentDir: paths.agentDir });
    agent.start();
    say(`${agent.name} up in ${paths.agentDir} (${agent.loaded.procedures.length} procedures)`);
    const stop = async () => {
      await agent.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    await new Promise(() => {});
    return 0;
  } catch (err) {
    if (err instanceof AlreadyRunning || err instanceof NoProgram) console.error(err.message);
    else console.error(`${err instanceof Error ? err.message : String(err)}\nrun \`endo incept\` to rewrite the program`);
    // A service exits 0 so the supervisor does not crash-loop; the foreground says what to do.
    return flags.service ? 0 : 1;
  }
}

async function down(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  const name = await agentName(paths);
  const removed = await removeService(name);
  say(removed ? `${name} stopped and its unit removed` : `${name}: no service unit${isLocked(paths.lock) ? " (a foreground `endo up` is running; Ctrl-C it)" : ""}`);
  return 0;
}

async function logs(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  if (!existsSync(paths.log)) {
    say(`no log yet at ${paths.log}`);
    return 0;
  }
  const text = readFileSync(paths.log, "utf8");
  const lines = text.split("\n");
  say(lines.slice(-50).join("\n").trimEnd());
  if (!flags.follow) return 0;
  let offset = statSync(paths.log).size;
  for (;;) {
    await Bun.sleep(500);
    const size = statSync(paths.log).size;
    if (size > offset) {
      process.stdout.write(readFileSync(paths.log, "utf8").slice(offset));
      offset = size;
    } else if (size < offset) offset = 0;
  }
}

async function listAgents(): Promise<number> {
  const entries = list();
  if (entries.length === 0) {
    say("no agents registered; `endo up` in an agent directory registers it");
    return 0;
  }
  for (const e of entries) {
    const state = !e.exists ? "gone" : isLocked(pathsOf(e.dir).lock) ? "up" : "down";
    say(`${e.name.padEnd(20)} ${state.padEnd(5)} ${e.dir}`);
  }
  return 0;
}

async function inceptCommand(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  try {
    const result = await incept({ agentDir: paths.agentDir, inceptor: flags.inceptor, manual: flags.manual, accept: flags.accept, log: say });
    if ("manual" in result) say(`run your coding agent in ${paths.agentDir}, then \`endo incept --accept\``);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** What `send` says about its caller: the current directory and its git HEAD. */
function callerContext(): { origin: string; ref?: string } {
  const origin = realpathSync(process.cwd());
  const git = (args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", origin, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  const head = git(["rev-parse", "HEAD"]);
  if (!head) return { origin };
  const dirty = git(["status", "--porcelain"]);
  return { origin, ref: dirty ? `${head}-dirty` : head };
}

async function send(flags: Flags): Promise<number> {
  const text = flags.rest.join(" ").trim();
  if (!text) return usage();
  const paths = target(flags);
  if (!paths) return 1;
  const id = flags.id ?? newId();
  const caller = callerContext();
  writeMessage(paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text, origin: caller.origin, ref: flags.ref ?? caller.ref, at: Date.now() });
  if (!flags.wait) {
    say(id);
    return 0;
  }
  return await waitAndPrint(paths.outbox, id);
}

async function call(flags: Flags): Promise<number> {
  const [procedure, ...pairs] = flags.rest;
  if (!procedure) return usage();
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(`args are KEY=VAL: ${pair}`);
      return 2;
    }
    args[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const paths = target(flags);
  if (!paths) return 1;
  const id = flags.id ?? newId();
  writeMessage(paths.inbox, { v: PROTOCOL_VERSION, kind: "call", id, procedure, args, origin: callerContext().origin, at: Date.now() });
  return await waitAndPrint(paths.outbox, id, flags.wait);
}

async function waitAndPrint(outbox: string, id: string, terminal = true): Promise<number> {
  const reply = await waitForReply(outbox, id, { timeoutMs: 24 * 60 * 60 * 1000, pollMs: 200, terminal });
  if (!reply) return 1;
  say(reply.text);
  return reply.ok || reply.state === "working" ? 0 : 1;
}

async function wait(flags: Flags): Promise<number> {
  const id = flags.rest[0];
  if (!id) return usage();
  const paths = target(flags);
  return paths ? waitAndPrint(paths.outbox, id) : 1;
}

interface StatusFile {
  name: string;
  open: string[];
  runs: unknown[];
  active: boolean;
  at: number;
  commands?: { name: string; description: string; args: Record<string, unknown>; required: string[] }[];
}

function readStatus(paths: ReturnType<typeof pathsOf>): StatusFile | null {
  try {
    return JSON.parse(readFileSync(paths.status, "utf8"));
  } catch {
    return null;
  }
}

async function commands(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  const status = readStatus(paths);
  if (!status) {
    console.error("the agent has not been up yet (no status.json); `endo up` first");
    return 1;
  }
  for (const c of status.commands ?? []) {
    const args = Object.keys(c.args).map((k) => (c.required.includes(k) ? `${k}=<${k}>` : `[${k}=…]`)).join(" ");
    say(`${c.name}${args ? ` ${args}` : ""}\n    ${c.description}`);
  }
  return 0;
}

async function status(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  const s = readStatus(paths);
  const up = isLocked(paths.lock);
  say(s ? `${s.name}: ${up ? (s.active ? "up, active" : "up, idle") : "down"}, ${s.open.length} open request(s), ${s.runs.length} running procedure(s) (as of ${new Date(s.at).toISOString()})` : "never up");
  try {
    const { inceptionStatus } = await import("../inception/incept.ts");
    const i = await inceptionStatus(paths, { load: false });
    if (i.changed.length) say(`  inputs changed since inception ${i.n}: ${i.changed.join(", ")} (an inception is due: \`endo incept\`)`);
    if (i.programEdited) say(`  program/agent.ts was edited by hand since inception ${i.n}`);
  } catch {}
  if (existsSync(paths.db)) {
    const store = openSqliteStore(paths.db);
    for (const f of allFrames(store, Math.max(0, store.lastSeq() - 10))) say(`  ${f.seq}  ${f.type.padEnd(11)} ${f.summary}`);
    store.close();
  }
  return 0;
}

async function charter(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  const { importGrant } = await import("../harness/agent.ts");
  const { ensureStateDir } = await import("../harness/paths.ts");
  const { grantActions } = await import("../grant/core.ts");
  const { renderGrant } = await import("../inception/workspace.ts");
  ensureStateDir(paths);
  const grant = await importGrant(paths);
  const actions = grantActions(grant, { name: grant.name, cwd: resolve(paths.agentDir, grant.cwd), charter: notRunning }, { reply: () => "not running" });
  say(renderGrant({ paths, grant, actions, n: 0, version: "" }).trimEnd());
  return 0;
}

async function replay(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  if (!existsSync(paths.db)) {
    say("no frames yet");
    return 0;
  }
  const store = openSqliteStore(paths.db);
  const frames = [...allFrames(store)];
  store.close();
  const id = flags.rest[0];
  for (const f of id ? framesAbout(frames, id) : frames) printFrame(f, true, say);
  return 0;
}

async function why(flags: Flags): Promise<number> {
  if (!flags.rest[0]) return usage();
  return replay(flags);
}

async function reset(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  if (isLocked(paths.lock)) {
    console.error("the agent is running; `endo down` (or Ctrl-C the foreground) first");
    return 1;
  }
  if (!existsSync(paths.state)) {
    say("nothing to reset");
    return 0;
  }
  if (!flags.force) {
    const answer = prompt(`delete ${paths.state} (the frame log, the program, src, snapshots)? the next \`endo up\` incepts a fresh agent [y/N]:`) ?? "";
    if (!/^y(es)?$/i.test(answer.trim())) return 1;
  }
  let name: string | undefined;
  try {
    name = await agentName(paths);
  } catch {}
  rmSync(paths.state, { recursive: true, force: true });
  if (name) release(name);
  say(`${paths.state} removed${name ? `; ${name} unregistered` : ""}`);
  return 0;
}

async function doctor(flags: Flags): Promise<number> {
  const paths = target(flags);
  if (!paths) return 1;
  let bad = 0;
  const note = (ok: boolean, text: string) => {
    if (!ok) bad++;
    say(`${ok ? "ok  " : "FAIL"} ${text}`);
  };
  let name: string | undefined;
  try {
    name = await agentName(paths);
    note(true, `grant loads: ${name}`);
  } catch (err) {
    note(false, `grant does not load: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  note(existsSync(paths.program), existsSync(paths.program) ? "program present" : "no program: `endo up` incepts one");
  const entry = lookup(name);
  note(!!entry && entry.exists && realpathSync(entry.dir) === realpathSync(paths.agentDir), entry ? `registry: ${name} → ${entry.dir}${entry.exists ? "" : " (gone)"}` : `registry: ${name} not registered (\`endo up\` registers)`);
  const svc = serviceInfo(name);
  if (svc.installed) {
    const unit = readFileSync(svc.file, "utf8");
    note(unit.includes(paths.agentDir), unit.includes(paths.agentDir) ? `unit ${svc.file}` : `unit ${svc.file} points elsewhere; \`endo up\` here rewrites it`);
    note(true, `service ${(await serviceRunning(name).catch(() => false)) ? "running" : "not running"}`);
  } else note(true, `no service unit (${isLocked(paths.lock) ? "a foreground up is running" : "down"})`);
  const { loadEnv } = await import("../harness/env.ts");
  const keys = loadEnv(paths);
  note(true, keys.length ? `env: ${keys.join(", ")}` : "env: no .endo/env (credentials must come from the environment)");
  const { describeProcedures } = await import("../procedures/describe.ts");
  const described = await describeProcedures(paths.procedures);
  note(described.failures.length === 0, `procedures: ${described.procedures.map((p) => p.name).join(", ") || "(none)"}${described.failures.length ? `; failing: ${described.failures.map((f) => `${f.name} (${f.error.split("\n")[0]})`).join("; ")}` : ""}`);
  if (existsSync(paths.program)) {
    const { inceptionStatus } = await import("../inception/incept.ts");
    const status = await inceptionStatus(paths);
    note(!status.loadError, status.loadError ? `program does not load: ${status.loadError}; run \`endo incept\`` : `program loads (inception ${status.n})`);
    note(true, status.changed.length ? `inputs changed since inception ${status.n}: ${status.changed.join(", ")}; an inception is due` : `inputs unchanged since inception ${status.n}`);
    if (status.programEdited) note(false, "program/agent.ts differs from what inception recorded: it was edited by hand");
  }
  return bad ? 1 : 0;
}

function usage(): number {
  console.error(USAGE);
  return 2;
}

const { command, flags } = parse(process.argv.slice(2));
const handlers: Record<string, (f: Flags) => Promise<number>> = { up, down, logs, incept: inceptCommand, send, call, wait, commands, status, charter, replay, why, reset, doctor };
const run = command ? handlers[command] : listAgents;
if (!run) process.exit(usage());
run(flags).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
