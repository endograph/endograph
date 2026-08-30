import type { Subprocess } from "bun";
import type { ProcessDef } from "../playbook/types.ts";
import { checkProbe } from "./probes.ts";

export type ProcessState =
  | "idle" // not yet started, or deliberately stopped
  | "starting" // spawned, readiness probe not yet green
  | "ready"
  | "exited"; // child gone (crash or clean exit)

const RING_LINES = 500;

/**
 * One supervised child. Holds the subprocess, a ring buffer of recent
 * output (the evidence `logs`/`why` and playbook matchers work from), and
 * readiness state. Restart policy lives a level up in the adapter.
 */
export class ManagedProcess {
  readonly def: ProcessDef;
  state: ProcessState = "idle";
  /** Set when state === "exited". */
  exitCode: number | null = null;
  startedAt: number | null = null;
  readyAt: number | null = null;
  exitedAt: number | null = null;

  private child: Subprocess | null = null;
  private ring: string[] = [];
  private waiters: (() => void)[] = [];
  private projectDir: string;

  constructor(def: ProcessDef, projectDir: string) {
    this.def = def;
    this.projectDir = projectDir;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Last `n` lines of combined stdout+stderr. */
  logs(n = 100): string[] {
    return this.ring.slice(-n);
  }

  logSeen(re: RegExp): boolean {
    return this.ring.some((line) => re.test(line));
  }

  /** Spawn the child. Resolves once spawned (not ready). */
  start(): void {
    if (this.child) throw new Error(`${this.def.name} already running`);
    const cwd = this.def.cwd
      ? `${this.projectDir}/${this.def.cwd}`
      : this.projectDir;
    this.ring = [];
    this.exitCode = null;
    this.exitedAt = null;
    this.readyAt = null;
    this.startedAt = Date.now();
    this.state = "starting";
    const child = Bun.spawn(["sh", "-c", this.def.cmd], {
      cwd,
      env: { ...process.env, ...this.def.env, FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    this.child = child;
    void this.consume(child.stdout as ReadableStream<Uint8Array>);
    void this.consume(child.stderr as ReadableStream<Uint8Array>);
    void child.exited.then((code) => {
      // A stop() swaps state to "idle" first; only real exits land here.
      if (this.child === child) {
        this.child = null;
        this.exitCode = code;
        this.exitedAt = Date.now();
        if (this.state !== "idle") this.state = "exited";
      }
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  /**
   * Wait until the readiness probe is green (or trivially ready when no
   * probe is declared). Returns false on timeout or early exit.
   */
  async awaitReady(): Promise<boolean> {
    const probe = this.def.ready;
    if (!probe) {
      if (this.state === "starting") this.state = "ready";
      this.readyAt = Date.now();
      return true;
    }
    const deadline = Date.now() + this.def.readyTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.state === "exited") return false;
      if (await checkProbe(probe, (re) => this.logSeen(re))) {
        this.state = "ready";
        this.readyAt = Date.now();
        return true;
      }
      await Bun.sleep(500);
    }
    return false;
  }

  /** SIGTERM, escalate to SIGKILL after a grace period. */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "idle";
      return;
    }
    this.state = "idle"; // deliberate: exit handler won't mark "exited"
    child.kill("SIGTERM");
    const gone = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    if (!gone) {
      child.kill("SIGKILL");
      await child.exited;
    }
    this.child = null;
  }

  /** Resolves next time the child exits (used by exit sensors). */
  onceExited(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of stream) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        this.ring.push(line);
        if (this.ring.length > RING_LINES) this.ring.shift();
      }
    }
    if (carry) this.ring.push(carry);
  }
}
