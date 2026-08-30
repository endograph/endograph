import { existsSync } from "node:fs";
import type { AgentDir } from "../agent/dir.ts";
import { newIncident, waitForReply, writeMessage, writeRequest } from "../inbox/inbox.ts";
import type { WorldEntry } from "../world/model.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { dim, supervisorAlive } from "./shared.ts";

const DEFAULT_WAIT_S = 30 * 60;

/**
 * `endo send [--ref <ref>] [--from <id>] [--wait] [--timeout <s>] <text…>`
 * Leave a request in the agent's inbox. Prints the incident id; with
 * --wait, blocks until the agent replies and exits 0/1 on ok/not-ok
 * (2 on timeout).
 */
export async function cmdSend(dir: AgentDir, argv: string[]): Promise<number> {
  let ref: string | undefined;
  let from: string | undefined;
  let wait = false;
  let timeoutS = DEFAULT_WAIT_S;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ref") ref = argv[++i];
    else if (a === "--from") from = argv[++i];
    else if (a === "--wait") wait = true;
    else if (a === "--timeout") timeoutS = Number(argv[++i]);
    else words.push(a);
  }
  const text = words.join(" ").trim();
  if (!text) throw new Error("usage: endo send [--ref <ref>] [--wait] <text>");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("--timeout must be seconds > 0");

  const request = {
    incident: newIncident(),
    // Identity is the checkout that asked — the worktree path.
    from: from ?? process.cwd(),
    ref: ref ?? (await gitRef(process.cwd())),
    text,
    at: Date.now(),
  };
  writeRequest(dir.inboxDir, request);
  console.log(request.incident);

  const alive = existsSync(dir.dbPath) && supervisorAlive(openSqliteStore(dir.dbPath), true);
  if (!alive) {
    console.error(
      dim(`warning: agent "${dir.name}" is not running — the request waits in ${dir.inboxDir}`),
    );
  }
  if (!wait) return 0;
  return awaitReply(dir, request.incident, timeoutS);
}

/**
 * `endo capex [--timeout <s>] [ask…]` — an on-demand research session.
 * When the agent is running, the ask rides the inbox as a capex-session
 * request and this waits for the reply; otherwise the session runs here.
 */
export async function cmdCapex(dir: AgentDir, argv: string[]): Promise<number> {
  let timeoutS = DEFAULT_WAIT_S;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--timeout") timeoutS = Number(argv[++i]);
    else words.push(a);
  }
  const ask = words.join(" ").trim() || undefined;
  const alive = existsSync(dir.dbPath) && supervisorAlive(openSqliteStore(dir.dbPath), true);
  if (!alive) {
    const { cmdCapexStandalone } = await import("./learn.ts");
    return cmdCapexStandalone(dir, ask);
  }
  const request = {
    incident: newIncident(),
    from: process.cwd(),
    text: ask ?? "on-demand research session",
    at: Date.now(),
    session: "capex",
  };
  writeRequest(dir.inboxDir, request);
  console.log(dim(`${request.incident} — capex session requested; waiting…`));
  return awaitReply(dir, request.incident, timeoutS);
}

/**
 * `endo reply <incident> [--failed] <text…>` — answer a request on the
 * agent's behalf. For background jobs a rule started (exit 75) and for
 * peers finishing work the agent delegated.
 */
export async function cmdReply(dir: AgentDir, argv: string[]): Promise<number> {
  let ok = true;
  let incident: string | undefined;
  const words: string[] = [];
  for (const a of argv) {
    if (a === "--failed" || a === "--not-ok") ok = false;
    else if (a === "--ok") ok = true;
    else if (!incident && /^inc-/.test(a)) incident = a;
    else words.push(a);
  }
  const text = words.join(" ").trim();
  if (!incident || !text) throw new Error("usage: endo reply <incident> [--failed] <text>");
  writeMessage(dir.inboxDir, { kind: "reply", incident, ok, text, from: process.cwd(), at: Date.now() });
  warnIfNotRunning(dir);
  return 0;
}

/**
 * `endo world set <subject> [--kind k] [--state green|yellow|red|gray] [--data '{…}'] <summary…>`
 * `endo world clear <subject>` — maintain the agent's world model from a
 * script or a peer, so `endo status` stays truthful without waking the model.
 */
export async function cmdWorld(dir: AgentDir, argv: string[]): Promise<number> {
  const [op, subject, ...rest] = argv;
  if ((op !== "set" && op !== "clear") || !subject) {
    throw new Error("usage: endo world set <subject> [--kind k] [--state s] [--data json] <summary> | endo world clear <subject>");
  }
  if (op === "clear") {
    writeMessage(dir.inboxDir, { kind: "world", op: "clear", subject, from: process.cwd(), at: Date.now() });
    warnIfNotRunning(dir);
    return 0;
  }
  let entryKind: string | undefined;
  let state: WorldEntry["state"] | undefined;
  let data: Record<string, unknown> | undefined;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--kind") entryKind = rest[++i];
    else if (a === "--state") {
      const v = rest[++i];
      if (v !== "green" && v !== "yellow" && v !== "red" && v !== "gray") throw new Error("--state must be green|yellow|red|gray");
      state = v;
    } else if (a === "--data") data = JSON.parse(rest[++i] ?? "{}");
    else words.push(a);
  }
  writeMessage(dir.inboxDir, {
    kind: "world",
    op: "set",
    subject,
    entryKind,
    state,
    summary: words.join(" ").trim(),
    data,
    from: process.cwd(),
    at: Date.now(),
  });
  warnIfNotRunning(dir);
  return 0;
}

function warnIfNotRunning(dir: AgentDir): void {
  const alive = existsSync(dir.dbPath) && supervisorAlive(openSqliteStore(dir.dbPath), true);
  if (!alive) {
    console.error(dim(`warning: agent "${dir.name}" is not running — the message waits in ${dir.inboxDir}`));
  }
}

/** `endo wait <incident> [--timeout <s>]` */
export async function cmdWait(dir: AgentDir, argv: string[]): Promise<number> {
  let timeoutS = DEFAULT_WAIT_S;
  let incident: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--timeout") timeoutS = Number(argv[++i]);
    else incident ??= a;
  }
  if (!incident) throw new Error("usage: endo wait <incident> [--timeout <s>]");
  return awaitReply(dir, incident, timeoutS);
}

async function awaitReply(dir: AgentDir, incident: string, timeoutS: number): Promise<number> {
  const store = openSqliteStore(dir.dbPath);
  try {
    const reply = await waitForReply(store, incident, { timeoutMs: timeoutS * 1000 });
    if (!reply) {
      console.error(`no reply to ${incident} within ${timeoutS}s`);
      return 2;
    }
    console.log(reply.text);
    return reply.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

/** "<short sha>[-dirty]" when cwd is a git checkout, else undefined. */
async function gitRef(cwd: string): Promise<string | undefined> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : undefined;
  };
  const sha = await run(["rev-parse", "--short", "HEAD"]);
  if (!sha) return undefined;
  const status = await run(["status", "--porcelain"]);
  return status ? `${sha}-dirty` : sha;
}
