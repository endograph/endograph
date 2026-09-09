import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { object } from "./protocol.ts";

export interface ServerMessage { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
export interface AppServer {
  request(method: string, params: unknown): Promise<any>;
  respond(id: string | number, result: unknown): void;
  subscribe(listener: (message: ServerMessage) => void): () => void;
  close(): Promise<void>;
}

/** One long-lived stdio connection; there is no shell or per-request CLI invocation. */
export class StdioAppServer implements AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: ServerMessage) => void>();
  private closed = false;
  private failure?: Error;
  constructor(private options: { command?: string; cwd: string }) {}

  private start(): Promise<void> {
    return this.ready ??= (async () => {
      if (this.closed) throw new Error("Codex app-server is closed");
      const child = this.child = spawn(this.options.command ?? "codex", ["app-server"], { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });
      // Drain diagnostics without exposing inherited credentials or large provider payloads.
      child.stderr.resume();
      child.stdin.on("error", (error) => this.fail(error));
      child.stdout.on("error", (error) => this.fail(error));
      child.on("error", (error) => this.fail(error));
      child.on("exit", (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code})`)));
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("Codex app-server message too large");
          const message = JSON.parse(line);
          if (!object(message)) throw new Error("Invalid Codex app-server message");
          if (message.method) for (const listener of this.listeners) listener(message);
          else if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
            else pending.resolve(message.result);
          }
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      });
      await this.sendRequest("initialize", { clientInfo: { name: "endograph", version: "0.0.1" }, capabilities: { experimentalApi: true } });
      this.send({ method: "initialized" });
    })();
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "endograph/disconnected", params: { message: error.message } });
  }
  private send(message: unknown) {
    if (this.failure) throw this.failure;
    if (this.closed || !this.child) throw new Error("Codex app-server is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private sendRequest(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async request(method: string, params: unknown) { await this.start(); return this.sendRequest(method, params); }
  respond(id: string | number, result: unknown) { this.send({ id, result }); }
  subscribe(listener: (message: ServerMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Codex app-server closed"));
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
