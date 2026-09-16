import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { collectRunnableActivations, normalizeSchema, runMachine, serializeInstance, type ProjectorExecutor } from "@projectors/core";
import { grantActions } from "../grant/core.ts";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { bindRuntime } from "../grant/bind.ts";
import { loadAgent, LoadError, type Loaded } from "../program/load.ts";
import { createRuns, type Runs, type RunRequest } from "../procedures/runs.ts";
import { atomicWrite, isMessage, isTerminal, newId, PROTOCOL_VERSION, writeReply, type CallMessage, type Delivered, type Message, type Reply, type ReplyState, type RequestMessage } from "../protocol/wire.ts";
import { openSqliteStore, StoreRecoveryRequired } from "../store/sqlite.ts";
import { threadStore } from "../store/threads.ts";
import { allFrames, type FrameInput, type FrameStore } from "../store/types.ts";
import { endoMeta, firstLine, frameInputOf } from "./frames.ts";
import { acquireLock } from "./lock.ts";
import { recoverPromotion } from "../inception/promotion.ts";
import { hashOf, inceptionStatus } from "../inception/incept.ts";
import { lookup } from "../cli/registry.ts";
import { liveRun } from "../procedures/runs.ts";
import { loadEnv } from "./env.ts";
import type { HostClient } from "../host/client.ts";
import { ensureStateDir, pathsOf, type Paths } from "./paths.ts";
import { heldElsewhere, HOST, readResidence, since, writeLoadFailure, type Status } from "./residence.ts";

/**
 * `endo up`, the running half: hold the lock, load the program, deliver
 * messages. One wake reason, a message. A call starts its procedure as a
 * process; a request is one frame on the machine, driven to quiescence.
 * Every request is answered exactly once; the harness fails what the
 * program left open. A change under `src/procedures/` reloads between
 * activations.
 */

export interface OpenOptions {
  agentDir: string;
  /** Override the grant's executor (tests, dry loads). */
  executor?: ProjectorExecutor;
  pollMs?: number;
  /** A running activation is aborted after this long. */
  activationTimeoutMs?: number;
  /** One line per frame as it is recorded (what `endo logs` shows). */
  log?: (line: string) => void;
  /** Another host took the state directory: the agent has stopped writing it and should be stopped. */
  onAdopted?: (host: string) => void;
  /** A persistence failure stopped this harness; reopen it to recover. */
  onFailure?: (error: Error) => void;
  /** Supplied by the host worker: the parent incepts, then replaces this process.
   * Without a host lifecycle, openAgent runs one fixed program generation. */
  inception?: { run(): Promise<void>; restart(): void };
  /** The worker's connection, supplied explicitly by its bootstrap. */
  host?: HostClient;
  /** A hosted worker receives its environment from the trusted parent. */
  environmentLoaded?: boolean;
}


export interface Agent {
  name: string;
  paths: Paths;
  grant: Grant;
  store: FrameStore;
  runs: Runs;
  readonly loaded: Loaded;
  /** Answer an open request. The error text when it is unknown or already answered. */
  reply(id: string, reply: { ok: boolean; state: ReplyState; text: string }): string | null;
  /** One router pass: drain the inbox, start calls, drive requests to quiescence. */
  poll(): Promise<void>;
  /** Run every battery's tick hook (the scheduler's, for one). */
  tick(now?: number): Promise<void>;
  reload(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  status(): Status;
}

export class AlreadyRunning extends Error {}
export class NoProgram extends Error {}
/** Another host holds the state directory and has not released it. */
export class HeldElsewhere extends Error {}

const REQUEST_HEADER = (m: Delivered<RequestMessage>) =>
  `[request id=${m.id} from=${m.from}${m.thread ? ` thread=${m.thread}` : ""}${m.ref ? ` ref=${m.ref}` : ""}${m.origin ? ` origin=${m.origin}` : ""}]`;

export async function openAgent(opts: OpenOptions): Promise<Agent> {
  const paths = pathsOf(resolve(opts.agentDir));
  ensureStateDir(paths);
  const lock = acquireLock(paths.lock);
  if (!lock) throw new AlreadyRunning(`${paths.agentDir} is already running`);
  let closeStore = () => {};
  try {
    recoverPromotion(paths);
    if (!existsSync(paths.program)) throw new NoProgram(`no program at ${paths.program}`);
    const held = heldElsewhere(paths);
    if (held) throw new HeldElsewhere(`${paths.agentDir} is held by ${held.host} (as of ${since(held.at)}); \`endo down\` there, or \`endo up --adopt\` to run it here`);
    if (!opts.environmentLoaded) loadEnv(paths);
    const grant = await loadGrant(paths);
    const bindings = await bindRuntime(paths, grant, opts.host);
    const name = grant.name;
    const cwd = resolve(paths.agentDir, grant.cwd);
    let persistenceFailure: StoreRecoveryRequired | undefined;
    const recoveryRequired = Promise.withResolvers<void>();
    let persistenceFailed = (error: StoreRecoveryRequired) => { persistenceFailure = error; };
    const store = openSqliteStore(paths.db, { onRecoveryRequired: (error) => persistenceFailed(error) });
    closeStore = () => store.close();
    const threads = threadStore(store);
    threads.list(); // Rebuild recorded thread indexes and queued requests when restoring.
    const executor = opts.executor ?? bindings.executor.create();
    const activationTimeoutMs = opts.activationTimeoutMs ?? 2 * 60 * 60 * 1000;

    // A logging observer must never roll back persistence or interrupt a
    // committed reply's publication.
    const log = (line: string) => {
      try { opts.log?.(line); } catch {}
    };
    const append = (input: FrameInput) => {
      const frame = store.append(input);
      log(`${String(frame.seq).padStart(4)}  ${new Date(frame.at).toISOString().slice(11, 19)}  ${frame.type.padEnd(11)} ${frame.id ?? ""}  ${frame.summary}`);
      return frame;
    };
    const record = (input: Omit<FrameInput, "at"> & { at?: number }) => append({ ...input, at: input.at ?? Date.now() });
    const open = new Map<string, { working: boolean }>();
    let active = false;
    let running = true;
    /** Set once another host's status lands: nothing is written here after that. */
    let adopted: string | undefined;
    let statusAt = 0;
    let incepting: number | undefined;
    let loaded!: Loaded;
    let agent!: Agent;
    let abortActive: ((reason: string) => void) | undefined;
    let unsubscribe = () => {};
    const lastFailure = new Map<string, string>();

    const status = (): Status => ({
      name,
      host: HOST,
      running,
      open: [...open.keys()],
      runs: runs.active().map((r) => ({ id: r.id, procedure: r.procedure, from: r.from, startedAt: r.startedAt })),
      active,
      ...(incepting ? { incepting } : {}),
      commands: loaded.procedures.filter((p) => p.expose).map((p) => ({ name: p.name, description: p.description, args: p.args, required: (p.inputSchema.required as string[]) ?? [] })),
      at: Date.now(),
    });
    const writeStatus = () => {
      if (adopted) return;
      const s = status();
      statusAt = s.at;
      writeFileSync(paths.status, JSON.stringify(s));
    };
    // The fence: a status newer than ours from another host means the directory moved. Record it, stop writing, hand over.
    const fenced = (): boolean => {
      if (adopted) return true;
      const r = readResidence(paths);
      if (!r || r.host === HOST || r.at <= statusAt) return false;
      adopted = r.host;
      record({ type: "residence", summary: `adopted by ${r.host}; stopping here`, payload: { by: r.host, at: r.at } });
      setTimeout(() => opts.onAdopted?.(r.host), 0);
      return true;
    };

    const commitReply = (r: Reply): Reply => {
      r = { ...r, from: `agent:${name}`, to: store.readMessage(r.id)?.from ?? r.to ?? `agent:${name}` };
      const frame: FrameInput = { type: "reply", id: r.id, summary: `${r.state}: ${firstLine(r.text)}`, payload: r, at: r.at };
      if (store.commitReply(r, frame)) log(`${String(store.lastSeq()).padStart(4)}  ${new Date(r.at).toISOString().slice(11, 19)}  reply       ${r.id}  ${frame.summary}`);
      return store.readReply(r.id)!;
    };
    const publishReply = (r: Reply): Reply => {
      const committed = commitReply(r);
      writeReply(paths.outbox, committed);
      return committed;
    };

    const runs = createRuns({
      paths,
      name,
      cwd,
      onReply: (run, reply) => {
        const committed = publishReply({ ...reply, id: run.id, to: run.from });
        // The supervisor removes completed runs after this durable callback.
        queueMicrotask(() => { if (running) writeStatus(); });
        return committed;
      },
    });
    persistenceFailed = (error) => {
      persistenceFailure = error;
      recoveryRequired.resolve();
      runs.close();
      unsubscribe();
      // Abort inference without attempting another write through the poisoned
      // store. The immutable archive decides recovery on the next open.
      try { abortActive?.(error.message); } catch {}
      log(error.message);
      if (agent) queueMicrotask(() => {
        void agent.stop().finally(() => { opts.onFailure?.(error); }).catch(() => {});
      });
    };
    const startRun = (request: RunRequest) => {
      if (persistenceFailure) throw persistenceFailure;
      const id = request.id ?? newId();
      const from = request.from ?? `agent:${name}`;
      const args = Object.entries(request.args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      // Record dispatch before starting any effect. A crash before a run can
      // report its identity fails the call on recovery instead of executing it twice.
      record({ type: "call", id, summary: `${from}: ${request.procedure.name}${args ? ` ${args}` : ""}`, payload: { procedure: request.procedure.name, args: request.args, from } });
      const run = runs.start({ ...request, id, from });
      writeStatus();
      return run;
    };

    const reply: Agent["reply"] = (id, r) => {
      if (persistenceFailure) throw persistenceFailure;
      const o = open.get(id);
      if (!o) return runs.get(id) ? `${id} is a call; its procedure answers it` : `no open request ${id}`;
      const at = Date.now();
      const committed = publishReply({ v: PROTOCOL_VERSION, id, ok: r.ok, state: r.state, text: r.text, at });
      if (isTerminal(committed.state)) open.delete(id);
      else o.working = true;
      writeStatus();
      return null;
    };
    const fail = (id: string, text: string) => reply(id, { ok: false, state: "failed", text });

    const actions = grantActions(
      bindings,
      { name, cwd, charter: () => loaded.charter },
      {
        reply,
        threads,
        stateSchema: (key) => {
          const descriptor = loaded.charter.states[key];
          return descriptor ? normalizeSchema(descriptor.schema).jsonSchema() : undefined;
        },
      },
    );

    const attach = (next: Loaded) => {
      unsubscribe();
      loaded = next;
      unsubscribe = next.machine.subscribe((frame) => append(frameInputOf(frame)));
      for (const f of next.failures) {
        if (lastFailure.get(f.name) === f.error) continue;
        lastFailure.set(f.name, f.error);
        next.machine.enqueueFrame({
          inert: true,
          messages: [{ type: "user", text: `[procedure ${f.name} failed to describe and is not available]\n${f.error}`, actor: { id: "endo", label: "endo" } }],
          metadata: endoMeta({ type: "procedure", summary: `${f.name} failed to describe: ${firstLine(f.error)}`, name: f.name, error: f.error }),
        });
      }
      for (const p of next.procedures) lastFailure.delete(p.name);
    };
    // The log is the evidence: what was asked, what was answered, what is still owed.
    const replies = new Map<string, ReplyState>();
    const requestFrames = new Map<string, string | undefined>();
    const calls = new Set<string>();
    const redriven = new Set<string>();
    let lastInception: { n: number; program?: string; changes?: string } | undefined;
    let briefed = -1;
    for (const f of allFrames(store)) {
      const payload = f.payload as {
        id?: string;
        metadata?: { endo?: { requests?: Delivered<RequestMessage>[]; briefing?: number; name?: string; error?: string } };
      } | undefined;
      const endo = payload?.metadata?.endo;
      switch (f.type) {
        case "request":
          for (const request of endo?.requests ?? []) {
            requestFrames.set(request.id, payload?.id);
          }
          briefed = Math.max(briefed, Number(endo?.briefing ?? -1));
          break;
        case "call":
          if (f.id) calls.add(f.id);
          break;
        case "redrive":
          if (f.id) redriven.add(f.id);
          break;
        case "procedure":
          if (endo?.name && endo.error) lastFailure.set(endo.name, endo.error);
          break;
        case "inception":
          lastInception = f.payload as typeof lastInception;
          break;
      }
    }
    const load = () => loadAgent({ paths, grant, bindings, store, executor, actions, cwd, startRun });
    try {
      attach(await load());
    } catch (err) {
      // The program does not load: say so where every reader looks (a frame, status.json) before giving up.
      if (err instanceof LoadError) {
        const detail = err.message.startsWith(`${err.stage}: `) ? err.message.slice(err.stage.length + 2) : err.message;
        record({ type: "error", summary: `program does not load at ${err.stage}: ${firstLine(detail)}`, payload: { stage: err.stage, error: detail } });
        writeLoadFailure(paths, { stage: err.stage, error: detail, program: hashOf(paths.program), at: Date.now() });
      }
      throw err;
    }
    // Someone edited the program by hand: it belongs to inception. Say so, once per start.
    if (lastInception?.program && hashOf(paths.program) !== lastInception.program)
      console.error(`warning: ${paths.program} differs from what the last inception wrote; run \`endo incept\` to make it inception's again`);

    // Outbox files are a materialized view: finish publication interrupted
    // after the durable reply commit, before recovering open work.
    for (const r of store.replies()) {
      replies.set(r.id, r.state);
      writeReply(paths.outbox, r);
    }
    for (const frame of allFrames(store)) {
      if (frame.type === "notification" && frame.id)
        atomicWrite(join(paths.outbox, "messages"), `${frame.id}.json`, frame.payload);
    }
    runs.recover();
    for (const id of calls) {
      if (isTerminal(replies.get(id)) || runs.get(id)) continue;
      const r: Reply = { v: PROTOCOL_VERSION, id, ok: false, state: "failed", text: "the agent restarted before this procedure ran; call it again", at: Date.now() };
      publishReply(r);
    }
    // A request whose frame still has runnable work was interrupted: re-drive it once. Anything else open is failed now.
    const runnable = new Set(collectRunnableActivations(loaded.machine).map((a) => a.sourceFrameId));
    const redrive: string[] = [];
    for (const [id, frameId] of requestFrames) {
      if (isTerminal(replies.get(id))) continue;
      open.set(id, { working: replies.get(id) === "working" });
      if (runnable.has(frameId ?? "") && !redriven.has(id)) {
        record({ type: "redrive", id, summary: "re-driving the interrupted activation once" });
        redrive.push(id);
      } else fail(id, "the agent restarted before answering this; send it again");
    }

    // The first activation on a new program is briefed: the inceptor's CHANGES.md, once, as a request from inceptor:<n>.
    let briefing: Delivered<RequestMessage> | undefined = lastInception?.changes && briefed < lastInception.n
      ? { v: PROTOCOL_VERSION, kind: "request", id: newId(), from: `inceptor:${lastInception.n}`, text: lastInception.changes, at: Date.now() }
      : undefined;

    let busy: Promise<void> = Promise.resolve();
    let retiring = false;
    const serially = (fn: () => Promise<void>) => {
      const run = () => {
        if (persistenceFailure) throw persistenceFailure;
        if (retiring) return;
        return fn();
      };
      return (busy = busy.then(run, run));
    };
    const drive = async (ids: string[]) => {
      const machine = loaded.machine;
      active = true;
      writeStatus();
      const inFlight = new Set<string>();
      const unsub = machine.subscribe((frame) => {
        for (const m of frame.messages) {
          if (m.type === "work" && m.kind === "activation") inFlight.add(m.activationId);
          if (m.type === "work" && m.kind === "completion") inFlight.delete(m.activationId);
        }
      });
      const abortAll = (note: string) => {
        for (const id of inFlight) machine.enqueueFrame({ messages: [{ type: "work", kind: "abort", activationId: id, note }], metadata: endoMeta({ type: "abort", summary: note }) });
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abortAll(`aborted: activation ran longer than ${activationTimeoutMs / 1000}s`);
      }, activationTimeoutMs);
      abortActive = (reason) => { clearTimeout(timer); abortAll(reason); };
      let failure: string | undefined;
      try {
        for await (const _ of runMachine(machine)) void _;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        failure = /context|too long|too many tokens|maximum.*tokens/i.test(text) ? `context overflow: ${text}` : text;
        record({ type: "error", summary: `activation failed: ${firstLine(failure)}`, payload: { error: text } });
        abortAll("aborted after a failure");
        try {
          for await (const _ of runMachine(machine)) void _;
        } catch {}
      } finally {
        abortActive = undefined;
        clearTimeout(timer);
        unsub();
      }
      for (const id of ids) {
        const o = open.get(id);
        if (!o || o.working) continue;
        fail(id, failure ? `the activation failed: ${failure}` : timedOut ? `the activation timed out after ${activationTimeoutMs / 1000}s` : "the activation ended without a reply");
      }
      store.writeSnapshot({ asOfSeq: store.lastSeq(), at: Date.now(), state: serializeInstance(machine.instance, machine.charter) });
      active = false;
      writeStatus();
    };

    const handleCall = (call: Delivered<CallMessage>) => {
      const spec = loaded.procedures.find((p) => p.name === call.procedure && p.expose);
      const reject = (text: string) => {
        const r: Reply = { v: PROTOCOL_VERSION, id: call.id, ok: false, state: "rejected", text, at: Date.now() };
        const committed = store.transaction(() => {
          record({ type: "call", id: call.id, summary: `${call.from}: ${call.procedure} (rejected)`, payload: { procedure: call.procedure, args: call.args, from: call.from } });
          return commitReply(r);
        });
        writeReply(paths.outbox, committed);
      };
      if (!spec) {
        const exposed = loaded.procedures.filter((p) => p.expose).map((p) => p.name);
        return reject(`unknown procedure "${call.procedure}"; exposed: ${exposed.length ? exposed.join(", ") : "(none)"}`);
      }
      const check = normalizeSchema(spec.action.inputSchema!).check(call.args ?? {});
      if (check.issues?.length) return reject(`invalid args for ${spec.name}: ${check.issues.map((i) => `${i.path?.join(".") ?? ""} ${i.message}`.trim()).join("; ")}`);
      startRun({ procedure: spec, args: call.args ?? {}, id: call.id, from: call.from });
    };

    const acceptInbox = () => {
      for (const f of readdirSync(paths.inbox).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
        const path = join(paths.inbox, f);
        let message: unknown;
        try {
          message = JSON.parse(readFileSync(path, "utf8"));
        } catch {}
        if (!isMessage(message)) {
          record({ type: "error", summary: `dropped a malformed inbox file: ${f}` });
          unlinkSync(path);
          continue;
        }
        // Acceptance and sender attribution survive removal of the file.
        // Duplicate writes retain the originally accepted payload and sender.
        store.acceptMessage({ ...message, from: stamp(message, path) });
        const priorReply = store.readReply(message.id);
        if (priorReply) writeReply(paths.outbox, priorReply);
        unlinkSync(path);
      }
    };

    const deliverRequests = async (batch: Delivered<RequestMessage>[]) => {
      if (batch.length === 0) return;
      const froms = [...new Set(batch.map((m) => m.from))].join(", ");
      const inceptor = batch.find((m) => m.from.startsWith("inceptor:"));
      try {
        store.transaction(() => {
          loaded.machine.enqueueFrame({
            messages: batch.map((m) => ({ type: "user", text: `${REQUEST_HEADER(m)}\n${m.text}`, actor: { id: m.from, label: m.from } })),
            metadata: endoMeta({
              type: "request",
              summary: batch.length === 1 ? `${batch[0]!.from}: ${firstLine(batch[0]!.text)}` : `${batch.length} requests from ${froms}`,
              id: batch.length === 1 ? batch[0]!.id : undefined,
              ids: batch.map((m) => m.id),
              requests: batch,
              ...(inceptor ? { briefing: Number(inceptor.from.slice(9)) } : {}),
            }),
          });
        });
      } catch (error) {
        // SQLite can roll back delivery, but not the machine's history and
        // work queue. Retire this worker and recover through ordinary startup.
        const failure = persistenceFailure ?? new StoreRecoveryRequired(error);
        if (!persistenceFailure) persistenceFailed(failure);
        throw failure;
      }
      briefing = undefined;
      for (const m of batch) open.set(m.id, { working: false });
      await drive(batch.map((m) => m.id));
    };

    const poll = async () => {
      if (retiring || fenced()) return;
      acceptInbox();
      const batch: Delivered<RequestMessage>[] = [];
      for (const message of store.pendingMessages()) {
        if (message.kind === "notification") {
          record({ type: "notification", id: message.id, summary: `${message.from} → ${message.to}`, payload: message });
          atomicWrite(join(paths.outbox, "messages"), `${message.id}.json`, message);
        } else if (message.to && message.to !== `agent:${name}`) {
          const rejected = store.transaction(() => {
            record({ type: "rejected-message", id: message.id, summary: `misaddressed message to ${message.to}`, payload: message });
            return commitReply({ v: PROTOCOL_VERSION, id: message.id, ok: false, state: "rejected", text: `this inbox serves agent:${name}`, at: Date.now() });
          });
          writeReply(paths.outbox, rejected);
        } else if (message.kind === "call") handleCall(message);
        else batch.push(message);
      }
      if (briefing) batch.unshift(briefing);
      await deliverRequests(batch);
    };

    const stamp = (message: Message | undefined, path: string): string => {
      if (message?.from) return message.from;
      if (message?.run && (!message.agent || message.agent === name)) {
        const run = runs.get(message.run);
        if (run) return `agent:${name}/${run.procedure}`;
      } else if (message?.run && message.agent) {
        // Another agent's procedure: its harness wrote runs/<id>.json while the run lives.
        const entry = lookup(message.agent);
        const procedure = entry?.exists ? liveRun(pathsOf(entry.dir), message.run) : undefined;
        if (procedure) return `agent:${message.agent}/${procedure}`;
      }
      try {
        const uid = statSync(path).uid;
        return uid === process.getuid?.() ? `local:${userInfo().username}` : `local:uid:${uid}`;
      } catch {
        return "local:unknown";
      }
    };

    const fileInputs = (files: string[]) => JSON.stringify(files.map((file) => {
      try { return [file, hashOf(file)]; } catch { return [file, null]; }
    }));
    const procedureFiles = () => existsSync(paths.procedures)
      ? readdirSync(paths.procedures).filter((file) => file.endsWith(".ts")).sort().map((file) => join(paths.procedures, file)) : [];
    const ownerFiles = (opts.inception ? [paths.grant, grant.manifest.path] : []).filter((file): file is string => !!file);
    let procedureInputs = fileInputs(procedureFiles());
    let ownerInputs = fileInputs(ownerFiles);
    const reload = async () => {
      procedureInputs = fileInputs(procedureFiles());
      try {
        attach(await load());
      } catch (err) {
        const text = err instanceof LoadError ? err.message : err instanceof Error ? err.message : String(err);
        record({ type: "error", summary: `reload failed, keeping the previous charter: ${firstLine(text)}`, payload: { error: text } });
      }
      writeStatus();
    };

    // Auto inception: when the owner's inputs (manifest, grant, endograph version) differ from the last inception
    // and nothing is open or running, ask the outer host to incept, then retire this worker. A failure keeps
    // the program that was running and waits for the inputs to move again.
    // The ordinary poll detects file changes; sandboxed file watchers can silently miss them.
    let inputsDirty = true;
    const refreshFiles = async () => {
      if (fileInputs(procedureFiles()) !== procedureInputs) await reload();
      const next = fileInputs(ownerFiles);
      if (next !== ownerInputs) { ownerInputs = next; inputsDirty = true; }
    };
    const maybeIncept = async () => {
      if (!opts.inception || grant.inception.mode !== "auto" || !inputsDirty || adopted || retiring || open.size || runs.active().length) return;
      inputsDirty = false;
      const s = await inceptionStatus(paths).catch(() => undefined);
      if (!s || !s.changed.length) return;
      incepting = s.n + 1;
      writeStatus();
      try {
        await opts.inception.run();
        retiring = true;
        queueMicrotask(opts.inception.restart);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        record({ type: "error", summary: `inception ${s.n + 1} (auto, ${s.changed.join(", ")} changed) failed; keeping the program, waiting for the inputs to change: ${firstLine(text)}`, payload: { error: text } });
        return;
      } finally {
        incepting = undefined;
      }
    };

    const tick = async (now: number) => {
      const ctx = {
        procedures: loaded.procedures.map((p) => ({ name: p.name, fields: p.fields })),
        call: (procedure: string, args: Record<string, unknown>) => {
          const spec = loaded.procedures.find((p) => p.name === procedure);
          if (!spec) return record({ type: "error", summary: `timer: no procedure ${procedure}` });
          startRun({ procedure: spec, args, from: `timer:${procedure}` });
        },
      };
      for (const b of bindings.batteries) {
        try {
          await b.hooks?.tick?.(now, ctx);
        } catch (err) {
          record({ type: "error", summary: `${b.name} tick failed: ${firstLine(err instanceof Error ? err.message : String(err))}` });
        }
      }
    };

    let loop: Promise<void> | undefined;
    let wake: (() => void) | undefined;
    let stopTask: Promise<void> | undefined;
    const serve = async () => {
      const hasTicks = bindings.batteries.some((b) => b.hooks?.tick);
      let nextTick = hasTicks ? Date.now() + 30_000 : Infinity;
      while (!retiring) {
        await agent.poll();
        if (retiring) break;
        const now = Date.now();
        if (now >= nextTick) {
          nextTick = now + 30_000;
          await agent.tick(now);
        }
        if (retiring) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(opts.pollMs ?? 1000, Math.max(0, nextTick - Date.now())));
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = undefined;
      }
    };
    agent = {
      name,
      paths,
      grant,
      store,
      runs,
      get loaded() {
        return loaded;
      },
      reply,
      poll: () => serially(async () => { await refreshFiles(); await poll(); await maybeIncept(); }),
      tick: (now = Date.now()) => serially(() => tick(now)),
      reload: () => serially(reload),
      start() {
        if (loop || retiring) return;
        loop = serve().catch((error) => {
          if (persistenceFailure) return; // Its fatal callback already owns shutdown.
          log(`agent loop failed: ${error instanceof Error ? error.message : String(error)}`);
          void agent.stop().finally(() => opts.onFailure?.(error instanceof Error ? error : new Error(String(error)))).catch(() => {});
        });
      },
      stop() {
        // Fence queued work immediately, then let the current turn finish.
        // A poisoned store cannot wait on work whose completion requires writing it.
        retiring = true;
        wake?.();
        return stopTask ??= (async () => {
          await Promise.race([busy.catch(() => {}), recoveryRequired.promise]);
          runs.close();
          unsubscribe();
          if (persistenceFailure) active = false;
          running = false;
          try { writeStatus(); }
          finally {
            try { store.close(); } finally { lock.release(); }
          }
        })();
      },
      status,
    };
    writeStatus();
    if (redrive.length) await serially(() => drive(redrive));
    if (briefing) await serially(poll);
    return agent;
  } catch (err) {
    try { closeStore(); } catch {}
    lock.release();
    throw err;
  }
}
