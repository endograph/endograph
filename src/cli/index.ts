#!/usr/bin/env bun
import { existsSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { CliCommand } from "../agent/define.ts";
import {
  createHome,
  defaultHome,
  DECLARATION_FILE,
  homePaths,
  isDeclarationDir,
  isHomeDir,
  isRunning,
  readDeclarationLink,
  type HomePaths,
} from "../agent/home.ts";
import { loadDeclaration, type LoadedDeclaration } from "../agent/load.ts";
import { claim, findByDeclaration, list as listRegistry, lookup, NameConflict } from "../agent/registry.ts";
import { AlreadyRunning, openAgent } from "../agent/run.ts";
import { localPrincipal, newIncident, readReply, waitForReply, writeMessage, PROTOCOL_VERSION, type Reply } from "../inbox/protocol.ts";
import { loadPlaybook } from "../playbook/parse.ts";
import { isEntryMap } from "../world/model.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { bold, dim, fmtFrame, framesAbout, framesOfIncident, openIncidents, recentFrames, worldModel } from "./query.ts";
import { installService, removeService, serviceInfo, serviceRunning } from "./service.ts";

const USAGE = `endo — embedded agents: a declaration, a mandate, an inbox, a playbook, a frame log

consumer commands (address an agent with --agent <name|home|declaration dir>, or run inside one):
  endo send [--ref r] [--wait] [--timeout s] <text…>   prose request; prints the incident id
  endo call <procedure> [KEY=VAL…] [--wait]            run an exposed procedure deterministically
  endo wait <incident> [--timeout s]                   block until the reply (exit 0 ok / 1 not ok / 2 timeout)
  endo commands                                        exposed procedures and their args
  endo status                                          world model, open requests, recent frames
  endo why <thing>                                     recent frames about a subject or incident
  endo replay <incident>                               every frame of one incident

owner commands:
  endo up [dir] [--home <dir>] [--declaration <dir>]   run the agent here (dir = declaration or home; cwd if omitted)
  endo up -d [dir]                                     …under launchd/systemd: now, at every login, after crashes
  endo down                                            stop the service and remove its unit
  endo <session> [ask…]                                a standing session a battery declares (learn, capex, …)
  endo reply <incident> [--failed] <text…>             answer on the agent's behalf (background jobs)
  endo world set <subject> [--state s] [--kind k] [--data json] <summary…> | world clear <subject>
  endo reset --force                                   wipe agent/ (log, inbox, src); keep declaration link and env
  endo doctor                                          registry, lock, links, service, credentials
  endo                                                 registered agents on this machine
`;

interface Flags {
  agent?: string;
  home?: string;
  declaration?: string;
  ref?: string;
  wait: boolean;
  detach: boolean;
  /** Set by the unit launchd/systemd runs: we are the service. */
  service: boolean;
  force: boolean;
  failed: boolean;
  timeout?: number;
  state?: string;
  kind?: string;
  data?: string;
  rest: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { wait: false, detach: false, service: false, force: false, failed: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--agent") f.agent = next();
    else if (a === "--home") f.home = next();
    else if (a === "--declaration") f.declaration = next();
    else if (a === "--ref") f.ref = next();
    else if (a === "--timeout") f.timeout = Number(next());
    else if (a === "--state") f.state = next();
    else if (a === "--kind") f.kind = next();
    else if (a === "--data") f.data = next();
    else if (a === "--wait") f.wait = true;
    else if (a === "-d" || a === "--detach") f.detach = true;
    else if (a === "--service") f.service = true;
    else if (a === "--force") f.force = true;
    else if (a === "--failed") f.failed = true;
    else f.rest.push(a);
  }
  return f;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

/**
 * Resolve the home to operate on: a home dir, a declaration dir (through
 * the registry, else its default home), or a registry name. Never walks up.
 */
function resolveHome(target: string | undefined): HomePaths {
  const t = target ?? process.env.ENDO_AGENT ?? process.cwd();
  const looksLikePath = t.includes("/") || t.startsWith(".") || t.startsWith("~") || t === process.cwd();
  if (looksLikePath) {
    const dir = expandHome(t);
    if (isHomeDir(dir)) return homePaths(realpathSync(dir), readDeclarationLink(dir));
    if (isDeclarationDir(dir)) {
      const registered = findByDeclaration(dir);
      if (registered) return homePaths(realpathSync(registered.home), readDeclarationLink(registered.home));
      const candidates = existingDefaultHomes(realpathSync(dir));
      if (candidates.length === 1) return homePaths(candidates[0]!, readDeclarationLink(candidates[0]!));
      throw new Error(`${dir} is a declaration that has not been started here (no home); run \`endo up\` in it first`);
    }
    throw new Error(`${dir} is neither a home (declaration link) nor a declaration (${DECLARATION_FILE})`);
  }
  const entry = lookup(t);
  if (!entry) throw new Error(`no agent "${t}" registered; known: ${listRegistry().map((e) => e.name).join(", ") || "(none)"}`);
  if (!entry.exists) throw new Error(`agent "${t}" is registered at ${entry.home}, which is gone; run \`endo up\` from its new location`);
  return homePaths(realpathSync(entry.home), readDeclarationLink(entry.home));
}

function existingDefaultHomes(declarationDir: string): string[] {
  const base = resolve(declarationDir, ".endo");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((n) => resolve(base, n))
    .filter((p) => isHomeDir(p));
}

/** The registered name of a home, if any (reverse lookup; no declaration import). */
function nameOf(home: HomePaths): string | undefined {
  for (const e of listRegistry()) {
    try {
      if (e.exists && realpathSync(e.home) === home.root) return e.name;
    } catch {}
  }
  return undefined;
}

async function main(): Promise<number> {
  const parsed = parseFlags(process.argv.slice(2));
  const [command, ...positional] = parsed.rest;
  const f: Flags = { ...parsed, rest: positional };
  if (!command) return cmdList();
  if (command === "help" || command === "--help" || command === "-h") return (console.log(USAGE), 0);
  switch (command) {
    case "up":
      return cmdUp(f);
    case "down":
      return cmdDown(f);
    case "send":
      return cmdSend(f);
    case "call":
      return cmdCall(f);
    case "wait":
      return cmdWait(f);
    case "commands":
      return cmdCommands(f);
    case "status":
      return cmdStatus(f);
    case "why":
      return cmdWhy(f);
    case "replay":
      return cmdReplay(f);
    case "reply":
      return cmdReply(f);
    case "world":
      return cmdWorld(f);
    case "reset":
      return cmdReset(f);
    case "doctor":
      return cmdDoctor(f);
    default:
      return cmdBattery(command, f);
  }
}

function cmdList(): number {
  const entries = listRegistry();
  if (entries.length === 0) {
    console.log(dim("no agents registered on this machine — run `endo up` in a declaration directory"));
    return 0;
  }
  for (const e of entries) {
    const running = e.exists && isRunning(homePaths(e.home, "").lockPath);
    console.log(`${e.name.padEnd(20)} ${e.exists ? (running ? "running" : "stopped") : "MISSING"}  ${e.home}`);
  }
  if (isDeclarationDir(process.cwd())) console.log(dim(`\n(cwd holds a declaration: ${resolve(process.cwd(), DECLARATION_FILE)})`));
  return 0;
}

/** up: declaration or home → (load, ensure home, claim) → foreground loop or service. */
async function cmdUp(f: Flags): Promise<number> {
  const dir = expandHome(f.rest[0] ?? process.cwd());
  let declarationDir: string;
  let homeRoot: string | undefined;
  if (isHomeDir(dir)) {
    homeRoot = realpathSync(dir);
    if (f.declaration) {
      // Repair a stale link.
      unlinkSync(resolve(dir, "declaration"));
      symlinkSync(realpathSync(expandHome(f.declaration)), resolve(dir, "declaration"));
    }
    declarationDir = readDeclarationLink(dir);
  } else if (isDeclarationDir(dir)) {
    declarationDir = realpathSync(dir);
  } else {
    console.error(`${dir} is neither a declaration directory (${DECLARATION_FILE}) nor a home; pass one`);
    return 2;
  }
  const loaded = await loadDeclaration(declarationDir);
  const name = loaded.definition.name;
  if (!homeRoot) {
    const registered = findByDeclaration(declarationDir);
    if (registered && f.home && realpathSync(registered.home) !== realpathSync(expandHome(f.home))) {
      console.error(`${name} already has a home at ${registered.home}; --home would create a second one`);
      return 2;
    }
    homeRoot = registered ? realpathSync(registered.home) : expandHome(f.home ?? defaultHome(declarationDir, name));
  }
  const home = createHome(homeRoot, declarationDir);

  if (f.detach) {
    try {
      claim(name, home.root);
    } catch (err) {
      if (err instanceof NameConflict) return (console.error(err.message), 2);
      throw err;
    }
    await installService(name, home.root);
    console.log(`${name} running under the service manager from ${home.root} — now, at every login, after crashes`);
    return 0;
  }

  if (!f.service && (await serviceRunning(name).catch(() => false))) {
    console.error(`${name} is running as a service (endo down to stop it, or endo status to watch)`);
    return 2;
  }
  let agent;
  try {
    agent = await openAgent({ home, loaded, onFrame: (input) => console.log(fmtFrame({ ...input, seq: 0 })) });
  } catch (err) {
    if (err instanceof AlreadyRunning || err instanceof NameConflict) return (console.error(err.message), 2);
    throw err;
  }
  console.log(bold(`${name} up`) + dim(` — home ${home.root}, cwd ${loaded.cwd}, ${loaded.definition.batteries.map((b) => b.name).join(", ") || "no batteries"}`));
  agent.start();
  const stop = async () => {
    console.log(dim("stopping…"));
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
  return 0;
}

async function cmdDown(f: Flags): Promise<number> {
  const home = resolveHome(f.agent ?? f.rest[0]);
  const name = nameOf(home);
  if (!name) return (console.error(`${home.root} is not registered`), 2);
  const removed = await removeService(name);
  console.log(removed ? `${name} stopped and its unit removed` : `${name}: no service unit${isRunning(home.lockPath) ? " (a foreground `endo up` is running; Ctrl-C it)" : ""}`);
  return 0;
}

function principal(): string {
  return localPrincipal();
}

async function cmdSend(f: Flags): Promise<number> {
  const home = resolveHome(f.agent);
  const text = f.rest.join(" ").trim();
  if (!text) return (console.error("usage: endo send [--ref r] [--wait] <text…>"), 2);
  const incident = newIncident();
  writeMessage(home.inboxDir, {
    v: PROTOCOL_VERSION,
    kind: "request",
    incident,
    from: principal(),
    origin: process.cwd(),
    ref: f.ref ?? (await gitRef(process.cwd())),
    text,
    at: Date.now(),
  });
  console.log(incident);
  warnIfDown(home);
  return f.wait ? waitAndPrint(home, incident, f.timeout) : 0;
}

async function cmdCall(f: Flags): Promise<number> {
  const home = resolveHome(f.agent);
  const [procedure, ...rest] = f.rest;
  if (!procedure) return (console.error("usage: endo call <procedure> [KEY=VAL…] [--wait]"), 2);
  const args: Record<string, string> = {};
  for (const kv of rest) {
    const m = kv.match(/^([A-Z][A-Z0-9_]*)=(.*)$/s);
    if (!m) return (console.error(`bad arg ${kv}: expected KEY=VAL with an UPPER_SNAKE key`), 2);
    args[m[1]!] = m[2]!;
  }
  const incident = newIncident();
  writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "call", incident, from: principal(), origin: process.cwd(), procedure, args, at: Date.now() });
  console.log(incident);
  warnIfDown(home);
  return f.wait ? waitAndPrint(home, incident, f.timeout) : 0;
}

async function cmdWait(f: Flags): Promise<number> {
  const home = resolveHome(f.agent);
  const incident = f.rest[0];
  if (!incident) return (console.error("usage: endo wait <incident> [--timeout s]"), 2);
  return waitAndPrint(home, incident, f.timeout);
}

async function waitAndPrint(home: HomePaths, incident: string, timeoutS?: number): Promise<number> {
  const reply = await waitForReply(home.outboxDir, incident, { timeoutMs: (timeoutS ?? 3600) * 1000 });
  if (!reply) return (console.error(`no reply to ${incident} yet`), 2);
  printReply(reply);
  return reply.ok ? 0 : 1;
}

function printReply(reply: Reply): void {
  console.log(`${reply.state}: ${reply.text}`);
}

function warnIfDown(home: HomePaths): void {
  if (!isRunning(home.lockPath)) console.error(dim(`warning: agent is not running — the message waits in ${home.inboxDir}`));
}

async function cmdCommands(f: Flags): Promise<number> {
  const home = resolveHome(f.agent);
  const entries = await loadPlaybook(home.srcDir);
  const exposed = entries.filter((e) => e.kind === "procedure" && e.expose);
  if (exposed.length === 0) return (console.log(dim("no exposed procedures")), 0);
  for (const p of exposed) {
    if (p.kind !== "procedure") continue;
    console.log(`${bold(p.name)}  ${p.description ?? ""}`);
    for (const [k, spec] of Object.entries(p.args)) console.log(`    ${k}${spec.required ? "" : "?"}  ${spec.description ?? ""}`);
  }
  return 0;
}

function cmdStatus(f: Flags): number {
  const home = resolveHome(f.agent);
  const store = openSqliteStore(home.dbPath);
  try {
    const name = nameOf(home) ?? "(unregistered)";
    console.log(`${bold(name)} ${isRunning(home.lockPath) ? "running" : "stopped"}  ${dim(home.root)}`);
    const world = worldModel(store);
    console.log(bold("\nworld"));
    if (Object.keys(world).length === 0) console.log(dim("  (empty)"));
    else if (isEntryMap(world)) {
      for (const s of Object.keys(world).sort()) {
        const e = world[s]!;
        console.log(`  ${light(e.state)} ${s.padEnd(24)} ${e.summary}`);
      }
    } else {
      console.log(JSON.stringify(world, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
    }
    const open = openIncidents(store);
    console.log(bold("\nopen"));
    if (open.length === 0) console.log(dim("  none"));
    for (const fr of open) console.log(`  ${fr.incident}  ${fr.summary}`);
    console.log(bold("\nrecent"));
    for (const fr of recentFrames(store, 15)) console.log("  " + fmtFrame(fr));
    return 0;
  } finally {
    store.close();
  }
}

function light(state: string): string {
  return { green: "●", yellow: "◐", red: "○", gray: "·" }[state] ?? "·";
}

function cmdWhy(f: Flags): number {
  const home = resolveHome(f.agent);
  const thing = f.rest.join(" ");
  if (!thing) return (console.error("usage: endo why <thing>"), 2);
  const store = openSqliteStore(home.dbPath);
  try {
    const frames = framesAbout(store, thing);
    if (frames.length === 0) console.log(dim(`nothing about "${thing}"`));
    for (const fr of frames) console.log(fmtFrame(fr));
    return 0;
  } finally {
    store.close();
  }
}

function cmdReplay(f: Flags): number {
  const home = resolveHome(f.agent);
  const incident = f.rest[0];
  if (!incident) return (console.error("usage: endo replay <incident>"), 2);
  const store = openSqliteStore(home.dbPath);
  try {
    for (const fr of framesOfIncident(store, incident)) {
      console.log(fmtFrame(fr));
      const payload = fr.payload as { messages?: { type: string; name?: string; kind?: string; input?: unknown; value?: unknown }[] } | undefined;
      for (const m of payload?.messages ?? []) {
        if (m.type === "action") console.log(dim(`    ${m.kind} ${m.name}: ${JSON.stringify(m.kind === "request" ? m.input : m.value)?.slice(0, 300)}`));
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

/** A battery's session: through the inbox when running, in-process otherwise. */
async function cmdSession(name: string, home: HomePaths, loaded: LoadedDeclaration, f: Flags): Promise<number> {
  const ask = f.rest.join(" ").trim();
  if (isRunning(home.lockPath)) {
    const incident = newIncident();
    writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident, from: principal(), text: ask, session: name, at: Date.now() });
    console.log(`${name} session requested (${incident}); waiting…`);
    return waitAndPrint(home, incident, f.timeout ?? 3600);
  }
  const agent = await openAgent({ home, loaded, onFrame: (input) => console.log(fmtFrame({ ...input, seq: 0 })) });
  try {
    const outcome = await agent.session(name, ask || undefined);
    console.log(outcome.summary);
    return outcome.completion === "error" ? 1 : 0;
  } finally {
    await agent.stop();
  }
}

function cmdReply(f: Flags): number {
  const home = resolveHome(f.agent);
  const [incident, ...text] = f.rest;
  if (!incident || text.length === 0) return (console.error("usage: endo reply <incident> [--failed] <text…>"), 2);
  writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "reply", incident, ok: !f.failed, text: text.join(" "), from: principal(), at: Date.now() });
  warnIfDown(home);
  return 0;
}

/**
 * `endo world set <key> [value…]`: the value is JSON when it parses, else
 * text. With --state/--kind/--data the value is a generic-map entry
 * ({kind, state, summary, data, updatedAt}) for agents on the default world.
 * `endo world clear <key…>` removes top-level keys.
 */
function cmdWorld(f: Flags): number {
  const home = resolveHome(f.agent);
  const [op, key, ...rest] = f.rest;
  const usage = "usage: endo world set <key> [value…] [--state s --kind k --data json] | world clear <key…>";
  if ((op !== "set" && op !== "clear") || !key) return (console.error(usage), 2);
  const patch: { set?: Record<string, unknown>; clear?: string[] } = {};
  if (op === "clear") {
    patch.clear = [key, ...rest];
  } else {
    const text = rest.join(" ");
    if (f.state || f.kind || f.data) {
      const state = f.state === "green" || f.state === "yellow" || f.state === "red" || f.state === "gray" ? f.state : "gray";
      patch.set = {
        [key]: { kind: f.kind ?? key.split(":")[0] ?? "entry", state, summary: text, data: f.data ? (JSON.parse(f.data) as Record<string, unknown>) : {}, updatedAt: Date.now() },
      };
    } else {
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {}
      patch.set = { [key]: value };
    }
  }
  writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "world", incident: "", ...patch, from: principal(), at: Date.now() });
  warnIfDown(home);
  return 0;
}

function cmdReset(f: Flags): number {
  const home = resolveHome(f.agent);
  if (!f.force) return (console.error(`this wipes ${home.agentDir} (frame log, inbox, src). Re-run with --force.`), 2);
  if (isRunning(home.lockPath)) return (console.error("agent is running; stop it first"), 2);
  rmSync(home.agentDir, { recursive: true, force: true });
  createHome(home.root, home.declaration);
  console.log(`reset ${home.root}: agent/ is empty; declaration link and env kept`);
  return 0;
}

async function cmdDoctor(f: Flags): Promise<number> {
  let problems = 0;
  const note = (ok: boolean, msg: string) => {
    console.log(`${ok ? "ok " : "!! "} ${msg}`);
    if (!ok) problems++;
  };
  const entries = listRegistry();
  console.log(bold("registry"));
  for (const e of entries) note(e.exists, `${e.name} -> ${e.home}${e.exists ? "" : " (missing — run endo up from its new location)"}`);
  if (entries.length === 0) console.log(dim("  none"));
  let home: HomePaths | undefined;
  try {
    home = resolveHome(f.agent);
  } catch (err) {
    console.log(dim(`\n(no agent in scope: ${err instanceof Error ? err.message : err})`));
    return problems ? 1 : 0;
  }
  console.log(bold(`\n${home.root}`));
  note(true, `declaration -> ${home.declaration}`);
  const name = nameOf(home);
  note(name !== undefined, name ? `registered as ${name}` : "not registered (run endo up)");
  note(true, isRunning(home.lockPath) ? "running (lock held)" : "stopped");
  if (existsSync(home.needsHumanPath)) {
    note(false, `needs a human: ${(await Bun.file(home.needsHumanPath).text()).trim().split("\n").slice(-1)[0]} — fix the declaration or playbook and \`endo up\`, or \`endo reset --force\``);
  }
  if (name) {
    const svc = serviceInfo(name);
    if (!svc.installed) note(true, "no service unit (foreground only)");
    else {
      const unit = await Bun.file(svc.file).text();
      note(unit.includes(home.root), unit.includes(home.root) ? `service unit ${svc.file}` : `service unit ${svc.file} points elsewhere — run \`endo up -d\` here`);
    }
  }
  note(existsSync(home.envPath) || !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY, `credentials: ${existsSync(home.envPath) ? "env file present" : "no env file; relying on the environment"}`);
  try {
    const entriesLoaded = await loadPlaybook(home.srcDir);
    note(true, `playbook: ${entriesLoaded.length} entries`);
  } catch (err) {
    note(false, `playbook does not load: ${err instanceof Error ? err.message : err}`);
  }
  return problems ? 1 : 0;
}

/** `endo <name>` contributed by a battery — a command or a session: needs the declaration. */
async function cmdBattery(command: string, f: Flags): Promise<number> {
  const home = resolveHome(f.agent);
  const loaded = await loadDeclaration(home.declaration);
  if (loaded.definition.sessions[command]) return cmdSession(command, home, loaded, f);
  const found: CliCommand | undefined = loaded.definition.batteries.flatMap((b) => b.commands ?? []).find((c) => c.name === command);
  if (!found) {
    const sessions = Object.entries(loaded.definition.sessions).map(([n, s]) => `  endo ${n} [ask…]  ${s.description}`);
    console.error(`unknown command "${command}"\n\n${USAGE}${sessions.length ? `\nsessions declared by ${loaded.definition.name}'s batteries:\n${sessions.join("\n")}\n` : ""}`);
    return 2;
  }
  const store = openSqliteStore(home.dbPath);
  try {
    return await found.run(f.rest, { name: loaded.definition.name, home, store, playbook: await loadPlaybook(home.srcDir) });
  } finally {
    store.close();
  }
}

async function gitRef(cwd: string): Promise<string | undefined> {
  try {
    const head = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const dirty = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
    const [sha, status] = await Promise.all([new Response(head.stdout as ReadableStream).text(), new Response(dirty.stdout as ReadableStream).text()]);
    if ((await head.exited) !== 0) return undefined;
    return `${sha.trim()}${status.trim() ? "-dirty" : ""}`;
  } catch {
    return undefined;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
