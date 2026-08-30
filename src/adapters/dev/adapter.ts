import type {
  Adapter,
  Drift,
  Sensor,
  StatusLine,
  Verb,
  VerbResult,
} from "../../core/types.ts";
import type { ProcessDef } from "../../playbook/types.ts";
import { ManagedProcess, type ProcessState } from "../../supervise/process.ts";
import { checkProbe } from "../../supervise/probes.ts";
import type { FrameInput } from "../../store/types.ts";
import type { WorldEntry } from "../../world/model.ts";

export type RecordFn = (
  input: Omit<FrameInput, "at"> & { at?: number },
  entries?: Record<string, WorldEntry | null>,
) => void;

const CRASHLOOP_WINDOW_MS = 10 * 60 * 1000;
const CRASHLOOP_LIMIT = 5;
const BACKOFF_MS = [0, 1000, 2000, 5000, 15_000];
const PROBE_FAILS_BEFORE_DRIFT = 3;

/**
 * The local dev supervisor adapter: owns a set of processes as children,
 * brings them up in dependency order with real readiness probes, and emits
 * drift for everything it cannot converge deterministically. Process
 * definitions come from the agent's own playbook (the bring-up procedure) —
 * operational knowledge lives in agent src/, not framework config.
 */
export class DevAdapter implements Adapter {
  readonly name = "dev";

  private procs = new Map<string, ManagedProcess>();
  private order: string[];
  private record: RecordFn;
  private restartTimes = new Map<string, number[]>();
  private handledExit = new Set<string>();
  private probeFails = new Map<string, number>();
  private probeTick = 0;

  constructor(opts: {
    defs: ProcessDef[];
    projectDir: string;
    record: RecordFn;
  }) {
    this.record = opts.record;
    this.order = topoSort(opts.defs);
    for (const def of opts.defs) {
      this.procs.set(def.name, new ManagedProcess(def, opts.projectDir));
    }
  }

  async up(): Promise<void> {
    for (const name of this.order) {
      await this.bringUp(this.procs.get(name)!);
    }
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.order].reverse()) {
      const mp = this.procs.get(name)!;
      if (mp.state === "idle") continue;
      await mp.stop();
      this.recordState(mp, `stopped ${name}`);
    }
  }

  sensors(): Sensor[] {
    return [
      {
        name: "process-watch",
        intervalMs: 2000,
        poll: () => this.watch(),
      },
    ];
  }

  verbs(): Verb[] {
    return [
      {
        name: "start",
        description: "Start a world-model process and wait for readiness.",
        run: (subject) => this.withProc(subject, (mp) => this.verbStart(mp)),
      },
      {
        name: "stop",
        description: "Stop a world-model process (SIGTERM, then SIGKILL).",
        run: (subject) => this.withProc(subject, (mp) => this.verbStop(mp)),
      },
      {
        name: "restart",
        description:
          "Restart a world-model process with backoff; refuses when crash-looping.",
        run: (subject) => this.withProc(subject, (mp) => this.verbRestart(mp)),
      },
      {
        name: "logs",
        description: "Last 100 output lines of a world-model process.",
        run: (subject) =>
          this.withProc(subject, async (mp) => ({
            ok: true,
            summary: `last ${Math.min(100, mp.logs().length)} lines of ${mp.def.name}`,
            detail: mp.logs(100).join("\n"),
          })),
      },
    ];
  }

  async status(): Promise<StatusLine[]> {
    return this.order.map((name) => {
      const mp = this.procs.get(name)!;
      return {
        subject: subjectOf(name),
        state: colorOf(mp.state),
        summary: describe(mp),
      };
    });
  }

  /** One pass of the deterministic watcher. Zero tokens. */
  private async watch(): Promise<Drift[]> {
    const drifts: Drift[] = [];
    this.probeTick++;

    for (const mp of this.procs.values()) {
      const name = mp.def.name;

      // Exits: emit once per exit; crash-looping escalates the drift class.
      if (mp.state === "exited" && !this.handledExit.has(name)) {
        this.handledExit.add(name);
        const looping = this.recentRestarts(name) >= CRASHLOOP_LIMIT;
        this.recordState(
          mp,
          `${name} exited with code ${mp.exitCode ?? "?"}`,
        );
        drifts.push({
          kind: looping ? "process.crashlooping" : "process.exited",
          subject: subjectOf(name),
          summary: looping
            ? `${name} is crash-looping (${CRASHLOOP_LIMIT}+ restarts in 10m), last exit code ${mp.exitCode ?? "?"}`
            : `${name} exited with code ${mp.exitCode ?? "?"}`,
          detail: mp.logs(40).join("\n"),
          data: { exitCode: mp.exitCode, restarts: this.recentRestarts(name) },
          observedAt: mp.exitedAt ?? Date.now(),
        });
      }

      // Ready processes get re-probed every ~10s; 3 consecutive fails is drift.
      if (mp.state === "ready" && mp.def.ready && this.probeTick % 5 === 0) {
        const ok = await checkProbe(mp.def.ready, (re) => mp.logSeen(re));
        if (ok) {
          this.probeFails.delete(name);
        } else {
          const fails = (this.probeFails.get(name) ?? 0) + 1;
          this.probeFails.set(name, fails);
          if (fails === PROBE_FAILS_BEFORE_DRIFT) {
            this.probeFails.delete(name);
            this.recordState(mp, `${name} readiness probe failing`, "yellow");
            drifts.push({
              kind: "probe.failed",
              subject: subjectOf(name),
              summary: `${name} is running but its readiness probe has failed ${PROBE_FAILS_BEFORE_DRIFT}x`,
              detail: mp.logs(40).join("\n"),
              observedAt: Date.now(),
            });
          }
        }
      }
    }
    return drifts;
  }

  private async bringUp(mp: ManagedProcess): Promise<void> {
    const name = mp.def.name;
    this.handledExit.delete(name);
    mp.start();
    this.recordState(mp, `starting ${name}: ${mp.def.cmd}`);
    const ready = await mp.awaitReady();
    if (ready) {
      this.recordState(mp, `${name} ready`);
    } else if (mp.state !== "exited") {
      // Running but never came ready; surface as drift via the next watch.
      this.recordState(mp, `${name} did not become ready in ${mp.def.readyTimeoutSeconds}s`, "yellow");
    }
    // An early exit is picked up by the watch sensor as process.exited.
  }

  private async verbStart(mp: ManagedProcess): Promise<VerbResult> {
    if (mp.state === "starting" || mp.state === "ready") {
      return { ok: true, summary: `${mp.def.name} already running` };
    }
    await this.bringUp(mp);
    // bringUp mutates mp.state; break the stale control-flow narrowing.
    const state = mp.state as ProcessState;
    return {
      ok: state === "ready",
      summary: `${mp.def.name} ${state}`,
      detail: state === "ready" ? undefined : mp.logs(20).join("\n"),
    };
  }

  private async verbStop(mp: ManagedProcess): Promise<VerbResult> {
    await mp.stop();
    this.recordState(mp, `stopped ${mp.def.name}`);
    return { ok: true, summary: `${mp.def.name} stopped` };
  }

  private async verbRestart(mp: ManagedProcess): Promise<VerbResult> {
    const name = mp.def.name;
    const recent = this.recentRestarts(name);
    if (recent >= CRASHLOOP_LIMIT) {
      return {
        ok: false,
        summary: `${name} is crash-looping (${recent} restarts in 10m); refusing to restart`,
      };
    }
    const backoff = BACKOFF_MS[Math.min(recent, BACKOFF_MS.length - 1)]!;
    if (backoff > 0) await Bun.sleep(backoff);
    this.noteRestart(name);
    await mp.stop();
    await this.bringUp(mp);
    return {
      ok: mp.state === "ready",
      summary:
        mp.state === "ready"
          ? `${name} restarted and ready (backoff ${backoff}ms)`
          : `${name} restarted but is ${mp.state}`,
      detail: mp.state === "ready" ? undefined : mp.logs(20).join("\n"),
    };
  }

  private recentRestarts(name: string): number {
    const cutoff = Date.now() - CRASHLOOP_WINDOW_MS;
    const times = (this.restartTimes.get(name) ?? []).filter((t) => t > cutoff);
    this.restartTimes.set(name, times);
    return times.length;
  }

  private noteRestart(name: string): void {
    this.restartTimes.set(name, [
      ...(this.restartTimes.get(name) ?? []),
      Date.now(),
    ]);
  }

  private recordState(
    mp: ManagedProcess,
    summary: string,
    override?: WorldEntry["state"],
  ): void {
    const name = mp.def.name;
    this.record(
      { type: "process", subject: subjectOf(name), summary },
      {
        [subjectOf(name)]: {
          kind: "process",
          state: override ?? colorOf(mp.state),
          summary: describe(mp),
          data: {
            pid: mp.pid ?? null,
            exitCode: mp.exitCode,
            restartsRecently: this.recentRestarts(name),
            cmd: mp.def.cmd,
          },
          updatedAt: Date.now(),
        },
      },
    );
  }

  private async withProc(
    subject: string,
    fn: (mp: ManagedProcess) => Promise<VerbResult>,
  ): Promise<VerbResult> {
    const name = subject.replace(/^process:/, "");
    const mp = this.procs.get(name);
    if (!mp) return { ok: false, summary: `unknown process "${name}"` };
    return fn(mp);
  }
}

function subjectOf(name: string): string {
  return `process:${name}`;
}

function colorOf(state: ProcessState): StatusLine["state"] {
  switch (state) {
    case "ready":
      return "green";
    case "starting":
      return "yellow";
    case "exited":
      return "red";
    case "idle":
      return "gray";
  }
}

function describe(mp: ManagedProcess): string {
  switch (mp.state) {
    case "ready": {
      const mins = mp.readyAt ? Math.round((Date.now() - mp.readyAt) / 60000) : 0;
      return `ready (pid ${mp.pid}, up ${mins}m)`;
    }
    case "starting":
      return `starting (pid ${mp.pid})`;
    case "exited":
      return `exited with code ${mp.exitCode ?? "?"}`;
    case "idle":
      return "stopped";
  }
}

/** Kahn topo sort over `after` edges; rejects cycles and unknown refs. */
export function topoSort(defs: ProcessDef[]): string[] {
  const names = new Set(defs.map((d) => d.name));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const def of defs) {
    indegree.set(def.name, 0);
  }
  for (const def of defs) {
    for (const dep of def.after ?? []) {
      if (!names.has(dep)) {
        throw new Error(`process ${def.name}: unknown dependency "${dep}"`);
      }
      indegree.set(def.name, (indegree.get(def.name) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), def.name]);
    }
  }
  const queue = defs.map((d) => d.name).filter((n) => indegree.get(n) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    order.push(name);
    for (const next of dependents.get(name) ?? []) {
      const deg = indegree.get(next)! - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (order.length !== defs.length) {
    throw new Error("process dependency cycle in bring-up procedure");
  }
  return order;
}
