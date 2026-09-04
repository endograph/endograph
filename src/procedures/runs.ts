import { spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, PROTOCOL_VERSION, readReply, writeReply, type Reply } from "../protocol/wire.ts";
import type { Paths } from "../harness/paths.ts";
import type { ProcedureSpec } from "./describe.ts";

/**
 * The run supervisor. One process per invocation, spawned detached in the
 * grant's cwd with the run's context in its environment, stdout and
 * stderr captured to files. The script writes its own ack (a `working`
 * reply) and its exit code; the supervisor turns the exit into the
 * terminal reply, whether it was the parent or came back after a restart.
 */

export interface RunRequest {
  procedure: ProcedureSpec;
  args: Record<string, unknown>;
  /** The call's id becomes the run's id; a model call gets a fresh one. */
  id?: string;
  /** The caller's `from`; absent for the agent's own tool call (the harness fills `agent:<name>`). */
  from?: string;
}

export interface Run {
  id: string;
  procedure: string;
  from: string;
  startedAt: number;
  /** The ack or the terminal reply, whichever lands first. */
  first: Promise<Reply>;
  terminal: Promise<Reply>;
}

export type RunStarter = (request: RunRequest) => Run;

export interface Runs {
  start: RunStarter;
  /** Runs started by a previous harness process: adopt their exits. */
  recover(): Run[];
  active(): Run[];
  /** The run behind a call id, while it runs. */
  get(id: string): Run | undefined;
}

interface RunRecord {
  id: string;
  procedure: string;
  file: string;
  from: string;
  args: Record<string, unknown>;
  startedAt: number;
  pid: number;
}

export function createRuns(opts: {
  paths: Paths;
  name: string;
  cwd: string;
  /** Every reply a run produces, as it lands: record it. */
  onReply(run: Run, reply: Reply): void;
}): Runs {
  const active = new Map<string, Run>();
  const { paths } = opts;
  const file = (id: string, ext: string) => join(paths.runs, `${id}.${ext}`);

  const settle = (record: RunRecord, code: number): Reply => {
    const out = read(file(record.id, "out"));
    const err = read(file(record.id, "err"));
    const ok = code === 0;
    const text = ok ? out.trimEnd() : [out.trimEnd(), err.trimEnd(), `${record.procedure} exited ${code}`].filter(Boolean).join("\n");
    const reply: Reply = { v: PROTOCOL_VERSION, id: record.id, ok, state: ok ? "completed" : "failed", text, at: Date.now() };
    writeReply(paths.outbox, reply);
    for (const ext of ["json", "out", "err", "exit"]) rmSync(file(record.id, ext), { force: true });
    return reply;
  };

  const track = (record: RunRecord, exited: Promise<number>): Run => {
    const terminal = exited.then((code) => {
      const reply = settle(record, code);
      active.delete(record.id);
      opts.onReply(run, reply);
      return reply;
    });
    const ack = (async () => {
      for (;;) {
        const reply = readReply(paths.outbox, record.id);
        if (reply?.state === "working") return reply;
        if (!active.has(record.id)) return terminal;
        await Bun.sleep(100);
      }
    })();
    const first = Promise.race([ack, terminal]).then((reply) => {
      if (reply.state === "working") opts.onReply(run, reply);
      return reply;
    });
    const run: Run = { id: record.id, procedure: record.procedure, from: record.from, startedAt: record.startedAt, first, terminal };
    active.set(record.id, run);
    return run;
  };

  /** Poll a run we did not spawn: its exit file, or its death. */
  const adoptedExit = (record: RunRecord): Promise<number> =>
    (async () => {
      for (;;) {
        const exit = read(file(record.id, "exit"));
        if (exit) return Number(exit) || 0;
        if (!alive(record.pid)) {
          writeFileSync(file(record.id, "err"), `${read(file(record.id, "err"))}\n${record.procedure} died without reporting an exit`);
          return 1;
        }
        await Bun.sleep(1000);
      }
    })();

  return {
    start(request) {
      const id = request.id ?? newId();
      const spec = request.procedure;
      const from = request.from ?? `agent:${opts.name}`;
      const record: RunRecord = { id, procedure: spec.name, file: spec.file, from, args: request.args, startedAt: Date.now(), pid: 0 };
      const child = spawn(process.execPath, ["run", spec.file], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", openSync(file(id, "out"), "w"), openSync(file(id, "err"), "w")],
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          ENDO_RUN: id,
          ENDO_PROCEDURE: spec.name,
          ENDO_AGENT: opts.name,
          ENDO_STATE: paths.state,
          ENDO_ARGS: JSON.stringify(request.args),
          ENDO_FROM: from,
        },
      });
      child.unref();
      record.pid = child.pid ?? 0;
      writeFileSync(file(id, "json"), JSON.stringify(record));
      const exited = new Promise<number>((resolve) => {
        child.on("error", (err) => {
          writeFileSync(file(id, "err"), err.message);
          resolve(127);
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });
      return track(record, exited);
    },
    recover() {
      const adopted: Run[] = [];
      for (const f of readdirSync(paths.runs).filter((f) => f.endsWith(".json"))) {
        try {
          const record = JSON.parse(readFileSync(join(paths.runs, f), "utf8")) as RunRecord;
          if (!active.has(record.id)) adopted.push(track(record, adoptedExit(record)));
        } catch {}
      }
      return adopted;
    },
    active: () => [...active.values()],
    get: (id) => active.get(id),
  };
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The procedure behind a run id in some agent's state directory, while that run lives. */
export function liveRun(paths: Paths, id: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(paths.runs, `${id}.json`), "utf8")) as { procedure?: string }).procedure;
  } catch {
    return undefined;
  }
}
