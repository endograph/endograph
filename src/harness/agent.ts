import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { collectRunnableActivations, normalizeSchema, runMachine, serializeInstance, type ProjectorExecutor } from "@projectors/core";
import { grantActions } from "../grant/core.ts";
import { loadGrant, type Grant } from "../grant/grant.ts";
import { loadAgent, LoadError, type Loaded } from "../program/load.ts";
import { createRuns, type Runs, type RunRequest } from "../procedures/runs.ts";
import { newId, PROTOCOL_VERSION, writeReply, type CallMessage, type Delivered, type Message, type Reply, type ReplyState, type RequestMessage } from "../protocol/wire.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames, type FrameInput, type FrameStore } from "../store/types.ts";
import { endoMeta, firstLine, frameInputOf } from "./frames.ts";
import { acquireLock } from "./lock.ts";
import { hashOf } from "../inception/incept.ts";
import { lookup } from "../cli/registry.ts";
import { liveRun } from "../procedures/runs.ts";
import { loadEnv } from "./env.ts";
import { ensureStateDir, pathsOf, type Paths } from "./paths.ts";

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
}

export interface Status {
  name: string;
  open: string[];
  runs: { id: string; procedure: string; from: string; startedAt: number }[];
  active: boolean;
  /** The exposed procedures: what `endo commands` prints. */
  commands: { name: string; description: string; args: Record<string, unknown>; required: string[] }[];
  at: number;
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

const TERMINAL = (state: ReplyState | undefined) => state !== undefined && state !== "working" && state !== "submitted";
const REQUEST_HEADER = (m: Delivered<RequestMessage>) =>
  `[request id=${m.id} from=${m.from}${m.ref ? ` ref=${m.ref}` : ""}${m.origin ? ` origin=${m.origin}` : ""}]`;

export async function openAgent(opts: OpenOptions): Promise<Agent> {
  const paths = pathsOf(resolve(opts.agentDir));
  ensureStateDir(paths);
  const lock = acquireLock(paths.lock);
  if (!lock) throw new AlreadyRunning(`${paths.agentDir} is already running`);
  try {
    if (!existsSync(paths.program)) throw new NoProgram(`no program at ${paths.program}`);
    loadEnv(paths);
    const grant = await loadGrant(paths);
    const name = grant.name;
    const cwd = resolve(paths.agentDir, grant.cwd);
    const store = openSqliteStore(paths.db);
    const executor = opts.executor ?? grant.executor.create();
    const activationTimeoutMs = opts.activationTimeoutMs ?? 2 * 60 * 60 * 1000;

    const append = (input: FrameInput) => {
      const frame = store.append(input);
      opts.log?.(`${String(frame.seq).padStart(4)}  ${new Date(frame.at).toISOString().slice(11, 19)}  ${frame.type.padEnd(11)} ${frame.id ?? ""}  ${frame.summary}`);
      return frame;
    };
    const record = (input: Omit<FrameInput, "at"> & { at?: number }) => append({ ...input, at: input.at ?? Date.now() });
    const open = new Map<string, { message: Delivered<RequestMessage>; working: boolean }>();
    const seen = new Set<string>();
    let active = false;
    let loaded!: Loaded;
    let unsubscribe = () => {};
    const lastFailure = new Map<string, string>();

    const status = (): Status => ({
      name,
      open: [...open.keys()],
      runs: runs.active().map((r) => ({ id: r.id, procedure: r.procedure, from: r.from, startedAt: r.startedAt })),
      active,
      commands: loaded.procedures.filter((p) => p.expose).map((p) => ({ name: p.name, description: p.description, args: p.args, required: (p.inputSchema.required as string[]) ?? [] })),
      at: Date.now(),
    });
    const writeStatus = () => writeFileSync(paths.status, JSON.stringify(status()));

    const runs = createRuns({
      paths,
      name,
      cwd,
      onReply: (run, reply) => {
        record({ type: "reply", id: run.id, summary: `${reply.state}: ${firstLine(reply.text)}`, payload: reply });
        writeStatus();
      },
    });
    const startRun = (request: RunRequest) => {
      const from = request.from ?? `agent:${name}`;
      const args = Object.entries(request.args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      const run = runs.start({ ...request, from });
      record({ type: "call", id: run.id, summary: `${from}: ${request.procedure.name}${args ? ` ${args}` : ""}`, payload: { procedure: request.procedure.name, args: request.args, from } });
      seen.add(run.id);
      writeStatus();
      return run;
    };

    const reply: Agent["reply"] = (id, r) => {
      const o = open.get(id);
      if (!o) return runs.get(id) ? `${id} is a call; its procedure answers it` : `no open request ${id}`;
      const at = Date.now();
      writeReply(paths.outbox, { v: PROTOCOL_VERSION, id, ok: r.ok, state: r.state, text: r.text, at });
      record({ type: "reply", id, summary: `${r.state}: ${firstLine(r.text)}`, payload: { ...r, to: id }, at });
      if (TERMINAL(r.state)) open.delete(id);
      else o.working = true;
      writeStatus();
      return null;
    };
    const fail = (id: string, text: string) => reply(id, { ok: false, state: "failed", text });

    const actions = grantActions(
      grant,
      { name, cwd, charter: () => loaded.charter },
      {
        reply,
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
    const requests = new Map<string, Delivered<RequestMessage>>();
    const frameOf = new Map<string, string>();
    const calls = new Set<string>();
    const redriven = new Set<string>();
    for (const f of allFrames(store)) {
      const payload = f.payload as { id?: string; metadata?: { endo?: { requests?: Delivered<RequestMessage>[] } } } | undefined;
      const endo = (payload?.metadata?.endo ?? {}) as { requests?: Delivered<RequestMessage>[] };
      if (f.type === "request") for (const r of endo.requests ?? []) (requests.set(r.id, r), seen.add(r.id), payload?.id && frameOf.set(r.id, payload.id));
      if (f.type === "call" && f.id) (calls.add(f.id), seen.add(f.id));
      if (f.type === "reply" && f.id) replies.set(f.id, (f.payload as Reply).state);
      if (f.type === "redrive" && f.id) redriven.add(f.id);
      if (f.type === "procedure") {
        const { name: n, error } = ((f.payload as { metadata?: { endo?: { name?: string; error?: string } } } | undefined)?.metadata?.endo ?? {}) as { name?: string; error?: string };
        if (n && error) lastFailure.set(n, error);
      }
    }
    const load = () => loadAgent({ paths, grant, store, executor, actions, cwd, startRun });
    attach(await load());
    {
      // Someone edited the program by hand: it belongs to inception. Say so, once per start.
      let recorded: string | undefined;
      for (const f of allFrames(store)) if (f.type === "inception") recorded = (f.payload as { program?: string }).program;
      if (recorded && hashOf(paths.program) !== recorded) console.error(`warning: ${paths.program} differs from what the last inception wrote; run \`endo incept\` to make it inception's again`);
    }

    for (const run of runs.recover()) void run;
    for (const id of calls) {
      if (TERMINAL(replies.get(id)) || runs.get(id)) continue;
      const r: Reply = { v: PROTOCOL_VERSION, id, ok: false, state: "failed", text: "the agent restarted before this procedure ran; call it again", at: Date.now() };
      writeReply(paths.outbox, r);
      record({ type: "reply", id, summary: `failed: restarted before the procedure ran`, payload: r });
    }
    // A request whose frame still has runnable work was interrupted: re-drive it once. Anything else open is failed now.
    const runnable = new Set(collectRunnableActivations(loaded.machine).map((a) => a.sourceFrameId));
    const redrive: string[] = [];
    for (const [id, message] of requests) {
      if (TERMINAL(replies.get(id))) continue;
      open.set(id, { message, working: replies.get(id) === "working" });
      if (runnable.has(frameOf.get(id) ?? "") && !redriven.has(id)) {
        record({ type: "redrive", id, summary: "re-driving the interrupted activation once" });
        redrive.push(id);
      } else fail(id, "the agent restarted before answering this; send it again");
    }

    // The first activation on a new program is briefed: the inceptor's CHANGES.md, once, as a request from inceptor:<n>.
    let briefing: Delivered<RequestMessage> | undefined;
    {
      let last: { n: number; changes?: string } | undefined;
      let briefed = -1;
      for (const f of allFrames(store)) {
        if (f.type === "inception") last = f.payload as { n: number; changes?: string };
        if (f.type === "request") briefed = Math.max(briefed, Number((f.payload as { metadata?: { endo?: { briefing?: number } } })?.metadata?.endo?.briefing ?? -1));
      }
      if (last?.changes && briefed < last.n) {
        briefing = { v: PROTOCOL_VERSION, kind: "request", id: newId(), from: `inceptor:${last.n}`, text: last.changes, at: Date.now() };
      }
    }

    let busy: Promise<void> = Promise.resolve();
    const serially = (fn: () => Promise<void>) => (busy = busy.then(fn, fn));

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
      const timer = setTimeout(() => ((timedOut = true), abortAll(`aborted: activation ran longer than ${activationTimeoutMs / 1000}s`)), activationTimeoutMs);
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
        record({ type: "call", id: call.id, summary: `${call.from}: ${call.procedure} (rejected)`, payload: { procedure: call.procedure, args: call.args, from: call.from } });
        writeReply(paths.outbox, r);
        record({ type: "reply", id: call.id, summary: `rejected: ${firstLine(text)}`, payload: r });
      };
      if (!spec) {
        const exposed = loaded.procedures.filter((p) => p.expose).map((p) => p.name);
        return reject(`unknown procedure "${call.procedure}"; exposed: ${exposed.length ? exposed.join(", ") : "(none)"}`);
      }
      const check = normalizeSchema(spec.action.inputSchema!).check(call.args ?? {});
      if (check.issues?.length) return reject(`invalid args for ${spec.name}: ${check.issues.map((i) => `${i.path?.join(".") ?? ""} ${i.message}`.trim()).join("; ")}`);
      startRun({ procedure: spec, args: call.args ?? {}, id: call.id, from: call.from });
    };

    const poll = async () => {
      const batch: Delivered<RequestMessage>[] = [];
      for (const f of readdirSync(paths.inbox).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
        const path = join(paths.inbox, f);
        let message: Message | undefined;
        try {
          message = JSON.parse(readFileSync(path, "utf8")) as Message;
        } catch {}
        const from = stamp(message, path);
        unlinkSync(path);
        if (!message || typeof message.id !== "string" || (message.kind !== "request" && message.kind !== "call")) {
          record({ type: "error", summary: `dropped a malformed inbox file: ${f}` });
          continue;
        }
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (message.kind === "call") handleCall({ ...message, from });
        else batch.push({ ...message, from });
      }
      if (briefing) (batch.unshift(briefing), (briefing = undefined));
      if (batch.length === 0) return;
      for (const m of batch) open.set(m.id, { message: m, working: false });
      const froms = [...new Set(batch.map((m) => m.from))].join(", ");
      loaded.machine.enqueueFrame({
        messages: batch.map((m) => ({ type: "user", text: `${REQUEST_HEADER(m)}\n${m.text}`, actor: { id: m.from, label: m.from } })),
        metadata: endoMeta({
          type: "request",
          summary: batch.length === 1 ? `${batch[0]!.from}: ${firstLine(batch[0]!.text)}` : `${batch.length} requests from ${froms}`,
          id: batch.length === 1 ? batch[0]!.id : undefined,
          ids: batch.map((m) => m.id),
          requests: batch,
          ...(batch.some((m) => m.from.startsWith("inceptor:")) ? { briefing: Number(batch.find((m) => m.from.startsWith("inceptor:"))!.from.slice(9)) } : {}),
        }),
      });
      await drive(batch.map((m) => m.id));
    };

    const stamp = (message: Message | undefined, path: string): string => {
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

    const reload = async () => {
      try {
        attach(await load());
      } catch (err) {
        const text = err instanceof LoadError ? err.message : err instanceof Error ? err.message : String(err);
        record({ type: "error", summary: `reload failed, keeping the previous charter: ${firstLine(text)}`, payload: { error: text } });
      }
      writeStatus();
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
      for (const b of grant.batteries) {
        try {
          await b.hooks?.tick?.(now, ctx);
        } catch (err) {
          record({ type: "error", summary: `${b.name} tick failed: ${firstLine(err instanceof Error ? err.message : String(err))}` });
        }
      }
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const watchers: FSWatcher[] = [];
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const agent: Agent = {
      name,
      paths,
      grant,
      store,
      runs,
      get loaded() {
        return loaded;
      },
      reply,
      poll: () => serially(poll),
      tick: (now = Date.now()) => serially(() => tick(now)),
      reload: () => serially(reload),
      start() {
        timer = setInterval(() => void agent.poll(), opts.pollMs ?? 1000);
        if (grant.batteries.some((b) => b.hooks?.tick)) ticker = setInterval(() => void agent.tick(), 30_000);
        try {
          watchers.push(watch(paths.inbox, { persistent: false }, () => void agent.poll()));
          watchers.push(
            watch(paths.procedures, { persistent: false }, () => {
              clearTimeout(reloadTimer);
              reloadTimer = setTimeout(() => void agent.reload(), 300);
            }),
          );
        } catch {}
      },
      async stop() {
        clearInterval(timer);
        clearInterval(ticker);
        clearTimeout(reloadTimer);
        for (const w of watchers) w.close();
        await busy;
        unsubscribe();
        store.close();
        lock.release();
      },
      status,
    };
    writeStatus();
    if (redrive.length) await serially(() => drive(redrive));
    if (briefing) await serially(poll);
    return agent;
  } catch (err) {
    lock.release();
    throw err;
  }
}
