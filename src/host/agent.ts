import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { languageModelFor } from "../grant/executor.ts";
import { acquireLock, isLocked } from "../harness/lock.ts";
import { loadEnv } from "../harness/env.ts";
import { ensureStateDir, pathsOf } from "../harness/paths.ts";
import { incept, inceptionStatus, type RuntimeLoader, type RuntimeLoadResult } from "../inception/incept.ts";
import { recoverPromotion } from "../inception/promotion.ts";
import { atomicWrite } from "../protocol/wire.ts";
import { describeHostActions, hostAction, HostActionError, type HostAction } from "./action.ts";
import { createHostBroker } from "./broker.ts";
import { createHostModelHandler } from "./model.ts";
import { closeSandbox, sandboxCommand } from "./sandbox.ts";
import { ipcTransport } from "./transport.ts";
import { CodexHost } from "@endograph/codex-executor/host";
import { hasCommittedActivation } from "../store/activation.ts";

const WORKER = join(import.meta.dir, "worker.ts");
const RESTART = 78;

/** One outer process per agent: owner code and credentials stay here. */
export interface AgentHost {
  loadRuntime: RuntimeLoader;
  grant(): Promise<Grant>;
  run(): Promise<number>;
  close(): Promise<void>;
}

export async function createAgentHost(opts: {
  agentDir: string;
  /** Additional definitions supplied by an embedding application, still selected by host_actions. */
  actions?: readonly HostAction[];
  inceptor?: string;
  log?: (line: string) => void;
  loadTimeoutMs?: number;
}): Promise<AgentHost> {
  const paths = pathsOf(realpathSync(resolve(opts.agentDir)));
  ensureStateDir(paths);
  loadEnv(paths);
  const log = (line: string) => {
    try { (opts.log ?? console.log)(line); } catch {} // Observers cannot decide activation.
  };
  let catalogueJson: string | undefined;
  const loadGrantedActions = async (): Promise<HostAction[]> => {
    const grant = await loadGrant(paths);
    const actions = [...(opts.actions ?? [])];
    for (const module of grant.hostModules) {
      const file = resolve(paths.agentDir, module);
      const imported = await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`);
      const value = imported.default;
      const entries = Array.isArray(value) ? value : value?.hostActions ?? [value];
      if (!Array.isArray(entries)) throw new Error(`${module} must export host actions or a battery with hostActions`);
      for (const entry of entries) actions.push(hostAction(entry));
    }
    if (actions.some((a) => a.name === "endoIncept")) throw new Error("endoIncept is reserved for the harness");
    const catalogue = describeHostActions(actions);
    // Descriptions support CLI/inceptor dry loads; authorization is always checked above the worker.
    const nextCatalogueJson = JSON.stringify(catalogue);
    if (nextCatalogueJson !== catalogueJson) {
      atomicWrite(paths.state, "host-actions.json", catalogue);
      catalogueJson = nextCatalogueJson;
    }
    const allowed = new Set(grant.hostActions);
    return actions.filter((action) => allowed.has(action.name));
  };
  await loadGrantedActions();
  const children = new Map<ChildProcess, Promise<number>>();
  let lastAttemptedInputs: string | undefined;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const launch = async (mode: "run" | "load", inputFile?: string) => {
    if (closing) throw new Error("agent host is closing");
    if (mode === "run" && existsSync(join(paths.state, "promotion.json"))) {
      const lock = acquireLock(paths.lock);
      if (!lock) throw new Error("cannot recover promotion while the agent is running");
      try { recoverPromotion(paths); } finally { lock.release(); }
    }
    const grant = await host.grant();
    if ("backend" in grant.executor) mkdirSync(join(paths.local, "executors", "codex"), { recursive: true, mode: 0o700 });
    const wrapped = await sandboxCommand(paths, grant, [process.execPath, WORKER, mode, paths.agentDir, ...(inputFile ? [inputFile] : [])]);
    if (closing) throw new Error("agent host is closing");
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd: paths.agentDir, env: wrapped.env,
      stdio: ["ignore", mode === "run" ? "inherit" : "ignore", "inherit", "ipc"], serialization: "json",
    });
    let incepting = false;
    const inceptionAction = mode === "run" ? hostAction({
      name: "endoIncept", description: "The outer harness revises the agent from its owner's inputs.",
      inputSchema: z.object({}).strict(),
      async run() {
        const revision = await inceptionStatus(paths);
        // The protected owner inputs authorize this operation. A worker request is only a hint.
        if (grant.inception.mode !== "auto" || !revision.changed.length || revision.inputs === lastAttemptedInputs || incepting || !isLocked(paths.lock))
          throw new HostActionError("automatic inception is unavailable");
        const status = JSON.parse(readFileSync(paths.status, "utf8"));
        if (status.active || status.open?.length || status.runs?.length) throw new HostActionError("automatic inception requires an idle agent");
        incepting = true;
        lastAttemptedInputs = revision.inputs;
        try {
          await incept({ agentDir: paths.agentDir, lock: "held", trigger: "auto", inceptor: opts.inceptor, log, loadRuntime: host.loadRuntime });
          return null;
        } catch (error) {
          let current: number;
          try {
            // A failed cleanup or SQLite commit may still have published
            // the new generation. Only the durable decision permits the
            // old worker to continue after an inception error.
            recoverPromotion(paths);
            current = (await inceptionStatus(paths)).n;
            if (current < revision.n) throw new Error("inception generation moved backwards");
          } catch (recoveryError) {
            child.kill("SIGKILL");
            throw recoveryError;
          }
          if (current === revision.n) throw error;
          log(`inception ${current} committed; restarting after finalization failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        } finally { incepting = false; }
      },
    }) : undefined;
    // One session owner per worker connection. Validation loads never start Codex.
    let codex: CodexHost | undefined;
    const aiModel = createHostModelHandler(async () => {
      const currentGrant = await host.grant();
      if (!("provider" in currentGrant.executor)) throw new Error("this executor does not provide a hosted language model");
      return languageModelFor(currentGrant.executor);
    });
    const broker = createHostBroker({
      describeOnly: mode === "load",
      identity: grant.name, transport: ipcTransport(child), maxBytes: 8 * 1024 * 1024, timeoutMs: 2 * 60 * 60 * 1000,
      actions: async () => {
        const actions = await loadGrantedActions();
        if (inceptionAction) actions.push(inceptionAction);
        return actions;
      },
      model: async (input, context, emit) => {
        const currentGrant = await host.grant();
        if ("backend" in currentGrant.executor) {
          if (mode !== "run" || !("backend" in grant.executor) || JSON.stringify(currentGrant.executor) !== JSON.stringify(grant.executor))
            throw new HostActionError("Codex configuration changed; restart the worker");
          codex ??= new CodexHost({ ...currentGrant.executor, stateDir: join(paths.local, "executors", "codex"),
            isActivationCommitted: (id) => hasCommittedActivation(paths.db, id) });
          try { return await codex.handle(input, context.signal, emit); }
          catch (error) {
            // A failed connection/turn is replaced on the next activation. Pending
            // metadata prevents an uncertain native turn from being replayed.
            if (input && typeof input === "object" && !Array.isArray(input) && input.op !== "tool-result") {
              const failed = codex;
              codex = undefined;
              await failed.close();
            }
            throw new HostActionError(error instanceof Error ? error.message : "Codex execution failed");
          }
        }
        return aiModel(input, context, emit);
      },
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(async () => {
      broker.close();
      await codex?.close();
      children.delete(child);
    });
    children.set(child, exited);
    return { child, exited };
  };
  const host: AgentHost = {
    async grant() { return loadGrant(paths); },
    async loadRuntime(input) {
      const dir = join(paths.state, "tmp");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `load-${crypto.randomUUID()}.json`);
      const resultFile = `${file}.result`;
      atomicWrite(dir, basename(file), input);
      try {
        const { child, exited } = await launch("load", file);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.loadTimeoutMs ?? 60_000);
        let code: number;
        try { code = await exited; } finally { clearTimeout(timer); }
        if (timedOut) throw new Error(`runtime load exceeded ${opts.loadTimeoutMs ?? 60_000}ms`);
        let result: { ok: boolean; result?: RuntimeLoadResult; error?: string };
        try { result = JSON.parse(readFileSync(resultFile, "utf8")); }
        catch { throw new Error(`sandboxed load exited ${code} without a result`); }
        if (!result.ok || !result.result) throw new Error(result.error ?? `sandboxed load exited ${code}`);
        return result.result;
      } finally { rmSync(file, { force: true }); rmSync(resultFile, { force: true }); }
    },
    async run() {
      const stop = () => { void host.close(); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        for (;;) {
          const { exited } = await launch("run");
          const code = await exited;
          if (closing || code !== RESTART) return code;
        }
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    },
    close() {
      return closeTask ??= (async () => {
        closing = true;
        const pending = [...children];
        // Signals can stop the Linux sandbox wrapper without reaching the
        // worker. The inherited IPC channel addresses the worker directly.
        for (const [child] of pending) {
          if (child.connected) child.send(JSON.stringify({ v: 1, kind: "shutdown" }), (error) => { if (error) child.kill("SIGTERM"); });
          else child.kill("SIGTERM");
        }
        const timer = setTimeout(() => { for (const [child] of pending) if (children.has(child)) child.kill("SIGKILL"); }, 5000);
        try { await Promise.allSettled(pending.map(([, exited]) => exited)); }
        finally { clearTimeout(timer); await closeSandbox(); }
      })();
    },
  };
  return host;
}
