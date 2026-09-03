import {
  action as anyCallerAction,
  createCharter,
  createMachine,
  createNode,
  createSourceInstance,
  hydrateInstance,
  isHorizonMessage,
  replaceState,
  resolveStates,
  runMachine,
  serializeInstance,
  tool,
  type AnyAction,
  type Charter,
  type Frame as ProjectorFrame,
  type FrameMessage,
  type Machine,
  type Node,
  type ProjectorExecutor,
  type SerializedInstance,
  type StateDescriptor,
  type StateUpdate,
} from "@projectors/core";
import { SELF_NODE_KEY } from "../judge/evolve.ts";
import { allFrames, type Frame, type FrameInput, type FrameStore } from "../store/types.ts";
import { hydrateWithMigration, MigrationFailed, modelMigrator, type Migrator } from "./migrate.ts";
import { applyWorldPatch, defaultWorld, WORLD_STATE_KEY, worldStateFor, type WorldPatch } from "./model.ts";

export { MigrationFailed } from "./migrate.ts";

export { WORLD_STATE_KEY } from "./model.ts";

/**
 * The projector integration. Every endograph frame is a projector frame:
 * the endograph envelope rides in frame.metadata.endo and is mirrored into
 * the store's columns. The world model and every battery state are
 * projected states on one agent node; changes are durable state.update
 * messages, so the log alone reproduces them. The snapshot is an
 * optimization.
 *
 * Compaction: a frame carrying projector's `horizon` message followed by
 * the model's own summary of everything before it. The machine renders
 * history from the latest horizon; the store and the machine keep every
 * frame, only the model's view is bounded.
 */

const INSTANCE_ID = "agent";
const NODE_KEY = "endo-agent";
export const COMPACTION_FRAME_TYPE = "compaction";
export const MIGRATION_FRAME_TYPE = "migration";

export interface OpenWorldOptions {
  machineId?: string;
  /** System framing for activations (composed from the mandate). */
  instructions?: string;
  /** The model's tools (caller: generator). */
  tools?: AnyAction[];
  /** Actions for both the model and external callers (exposed procedures). */
  commands?: AnyAction[];
  /** Projected states. The world state (key "world") must be among them; openWorld adds the default when absent. */
  states?: StateDescriptor[];
  executor?: ProjectorExecutor;
  /** Per-node executor config, namespaced by executor identity. */
  executorConfig?: Record<string, unknown>;
  /** Stamped into every frame's provenance: which process produced it. */
  runner?: Record<string, unknown>;
  /** Declared children of the root (the self among them), and the actions their parts carry. */
  children?: Node[];
  childActions?: AnyAction[];
  /**
   * Hydration recovery when the persisted instance no longer fits the
   * charter. Default: the model, as a bootstrap activation on this store.
   * Explicitly `null` disables it (hydration errors throw).
   */
  migrate?: Migrator | null;
  /** Observe every stored frame, the executor's included (the live terminal surface). */
  onFrame?: (input: FrameInput) => void;
  /** The store refused an append: nothing is being recorded any more. Fatal by definition. */
  onStoreError?: (err: unknown) => void;
}

export interface World {
  world(): Record<string, unknown>;
  /** A projected state's current value (schema defaults applied by the caller). */
  state<T>(key: string, fallback: T): T;
  /** Record a frame; optionally fold a world patch (set/clear top-level keys) into it. */
  record(input: FrameInput, patch?: WorldPatch): void;
  /** Record a frame carrying a replacement of a projected state. */
  recordState(input: FrameInput, key: string, value: unknown): void;
  /** Record a frame carrying any state update (patch, append, replace). */
  updateState(input: FrameInput, key: string, update: StateUpdate): void;
  snapshot(): void;
  /**
   * Fold frames the machine has queued (observations, replayed history)
   * without scheduling work. Only `runMachine` consumes the queue; without
   * this, a charter-only agent's queue grows until the next activation and
   * the next activation's drain would see history it did not produce.
   * Never call it while an activation is being driven.
   */
  drain(): Promise<number>;
  /** Record `summary` as the new beginning of history and rebuild. */
  compact(summary: string): void;
  /** Frames the machine currently holds (since the last compaction). */
  historyLength(): number;
  /** New mandate, executor, or tool surface; the machine is rebuilt from the store (migrating the instance if it no longer fits). */
  reconfigure(patch: { instructions?: string; executor?: ProjectorExecutor; tools?: AnyAction[]; commands?: AnyAction[] }): Promise<void>;
  /** The agent's self component as persisted: what it has made of itself. */
  self(): SerializedInstance | undefined;
  readonly machine: Machine;
  readonly charter: Charter;
  close(): void;
}

/**
 * The root generator is the owner's: mandate, tools, states — fixed,
 * registered, never transitioned. Declared children sit under it: a
 * component's parts project upward into the agent's activations (the self,
 * `evolvable()`, is one: notes, chosen tools, and the evolution tools that
 * act on it); a generator runs on its own trigger. All are registered so
 * the initial instance serializes as refs; a transitioned self is a de novo
 * node of registered refs and text.
 */
function buildCharter(opts: {
  instructions: string;
  tools: AnyAction[];
  commands: AnyAction[];
  children: Node[];
  childActions: AnyAction[];
  states: StateDescriptor[];
  executorConfig?: Record<string, unknown>;
}) {
  const agentNode = createNode({
    key: NODE_KEY,
    instructions: opts.instructions,
    states: opts.states,
    parts: [...opts.tools.map((a) => tool(a)), ...opts.commands.map((a) => anyCallerAction(a, "any"))],
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
    ...(opts.executorConfig ? { executorConfig: opts.executorConfig } : {}),
  });
  const charter = createCharter({
    key: "endograph",
    version: "2",
    nodes: [agentNode, ...opts.children],
    actions: [...opts.tools, ...opts.commands, ...opts.childActions],
    states: opts.states,
  });
  return { agentNode, charter };
}

export async function openWorld(store: FrameStore, opts: OpenWorldOptions = {}): Promise<World> {
  let instructions = opts.instructions ?? "You are an embedded agent tending a bounded domain.";
  let executor = opts.executor;
  let tools = opts.tools ?? [];
  let commands = opts.commands ?? [];
  const children = opts.children ?? [];
  const childActions = opts.childActions ?? [];
  const states = opts.states?.some((s) => s.key === WORLD_STATE_KEY) ? [...opts.states] : [worldStateFor(defaultWorld), ...(opts.states ?? [])];
  const rebuildCharter = () => buildCharter({ instructions, tools, commands, children, childActions, states, executorConfig: opts.executorConfig });
  let { agentNode, charter } = rebuildCharter();
  const migrator = (): Migrator | undefined =>
    opts.migrate === null ? undefined : (opts.migrate ?? (executor ? modelMigrator(executor, store, opts.machineId ?? "endo") : undefined));

  const freshInstance = () =>
    createSourceInstance({ id: INSTANCE_ID, node: agentNode, children: children.map((node) => ({ id: node.key, node })) });

  /**
   * Hydrate the snapshot (migrating if it no longer fits the charter), then
   * replay later frames. A replayed instance message can dangle too; then
   * the instance as it stands is migrated and replay continues after the
   * frame that failed. Any migration ends with a fresh snapshot, so the
   * failing frame is never replayed again.
   */
  const build = async (): Promise<Machine> => {
    const snap = store.readSnapshot();
    let instance;
    let replayFrom = 0;
    let migrated = false;
    const note = (attempt: number, error: string) =>
      store.append({ type: MIGRATION_FRAME_TYPE, subject: "self", summary: `instance no longer hydrates (attempt ${attempt}): ${error.split("\n")[0]}`, at: Date.now() });
    if (snap) {
      const result = await hydrateWithMigration(snap.state as SerializedInstance, charter, migrator(), note);
      instance = result.instance;
      migrated = result.migrated;
      replayFrom = snap.asOfSeq;
    } else {
      instance = freshInstance();
    }
    resolveStates(instance);
    let machine: Machine = createMachine({ id: opts.machineId ?? "endo", instance, charter, executor, runner: opts.runner });
    for (const stored of allFrames(store, 1000, replayFrom)) {
      // Only projector frames replay; a row without one (hand-inserted, foreign) is history, not machine input.
      const payload = stored.payload as ProjectorFrame | undefined;
      if (!payload || !Array.isArray(payload.messages)) continue;
      try {
        machine.enqueueFrame(payload);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const result = await hydrateWithMigration(serializeInstance(machine.instance, charter), charter, migrator(), note);
        // The frame that failed is history now; the migrated instance carries whatever survived it.
        machine = createMachine({ id: opts.machineId ?? "endo", instance: result.instance, charter, executor, runner: opts.runner });
        migrated = true;
        store.append({ type: MIGRATION_FRAME_TYPE, subject: "self", summary: `frame ${stored.seq} could not replay and was migrated past: ${error.split("\n")[0]}`, at: Date.now() });
      }
    }
    if (migrated) {
      store.writeSnapshot({ asOfSeq: store.lastSeq(), at: Date.now(), state: serializeInstance(machine.instance, charter) });
      store.append({ type: MIGRATION_FRAME_TYPE, subject: "self", summary: "instance migrated and snapshotted", at: Date.now() });
    }
    // Persist from here on; subscribing after replay avoids re-appending.
    // Every stored frame — the runtime's and the executor's — is observable.
    machine.subscribe((frame) => {
      const endo = (frame.metadata?.endo ?? {}) as Partial<FrameInput>;
      const input: FrameInput = {
        type: endo.type ?? frameTypeOf(frame),
        subject: endo.subject,
        summary: endo.summary ?? describeFrame(frame),
        incident: endo.incident,
        at: endo.at ?? Date.now(),
        payload: frame,
      };
      try {
        store.append(input);
      } catch (err) {
        if (!opts.onStoreError) throw err;
        opts.onStoreError(err);
        return;
      }
      opts.onFrame?.(input);
    });
    // A declared child absent from the persisted instance (declared after
    // it was persisted, or ceded) is attached — durably, as a spawn frame.
    const missing = children.filter((node) => !machine.instance.children?.some((c) => c.node.key === node.key));
    if (missing.length) {
      machine.enqueueFrame({
        inert: true,
        messages: [{ type: "instance", kind: "spawn", parentInstanceId: INSTANCE_ID, children: missing.map((node) => ({ id: node.key, node: node.key })) }],
        metadata: { endo: { type: "evolve", subject: "self", summary: `attached declared child(ren): ${missing.map((n) => n.key).join(", ")}`, at: Date.now() } },
      });
    }
    return machine;
  };

  let machine = await build();

  const readState = <T>(key: string, fallback: T): T => {
    const resolved = resolveStates(machine.instance).find((s) => s.descriptor.key === key);
    return (resolved?.container.value as T | undefined) ?? fallback;
  };
  const readWorld = (): Record<string, unknown> => readState<Record<string, unknown>>(WORLD_STATE_KEY, {});

  const enqueue = (input: FrameInput, extra: FrameMessage[], text?: string) => {
    machine.enqueueFrame({
      // Inert: observations never trigger work. The judgment layer
      // enqueues its own non-inert frames (judge/activate.ts).
      inert: true,
      messages: [
        { type: "user", text: text ?? input.summary, actor: { id: `endo:${input.type}`, label: input.type } },
        ...extra,
      ],
      metadata: { endo: { ...input, payload: input.payload } },
    });
  };
  const stateMessage = (stateKey: string, update: StateUpdate): FrameMessage => ({
    type: "instance",
    kind: "state.update",
    instanceId: INSTANCE_ID,
    stateKey,
    update,
  });
  const writeSnapshot = () => {
    store.writeSnapshot({ asOfSeq: store.lastSeq(), at: Date.now(), state: serializeInstance(machine.instance, charter) });
  };
  /** Frames since the latest horizon, inclusive: what the model sees. */
  const historyLength = () => {
    const frames = machine.frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i]!.messages.some(isHorizonMessage)) return frames.length - i;
    }
    return frames.length;
  };
  const rebuild = async () => {
    // Snapshot under the old charter first: the new charter hydrates it (migrating if it must).
    writeSnapshot();
    ({ agentNode, charter } = rebuildCharter());
    machine = await build();
  };

  return {
    get machine() {
      return machine;
    },
    get charter() {
      return charter;
    },
    world: readWorld,
    state: readState,
    record(input, patch) {
      const extra: FrameMessage[] = [];
      if (patch && (Object.keys(patch.set ?? {}).length > 0 || (patch.clear?.length ?? 0) > 0)) {
        // A patch cannot delete a key, so every world write is a replacement
        // of the (small) whole; the machine validates it against the schema.
        extra.push(stateMessage(WORLD_STATE_KEY, replaceState(applyWorldPatch(readWorld(), patch))));
      }
      enqueue(input, extra);
    },
    recordState(input, key, value) {
      enqueue(input, [stateMessage(key, replaceState(value))]);
    },
    updateState(input, key, update) {
      enqueue(input, [stateMessage(key, update)]);
    },
    snapshot: writeSnapshot,
    async drain() {
      let n = 0;
      for await (const _frame of runMachine(machine, { scheduleWork: false })) n++;
      return n;
    },
    compact(summary) {
      const firstLine = summary.split("\n").find((l) => l.trim())?.trim() ?? "compaction";
      const framesBefore = historyLength();
      machine.enqueueFrame({
        inert: true,
        messages: [
          { type: "horizon" },
          {
            type: "user",
            text: `Summary of everything before this point (older frames are in the store, not in view):\n\n${summary}`,
            actor: { id: `endo:${COMPACTION_FRAME_TYPE}`, label: COMPACTION_FRAME_TYPE },
          },
        ],
        metadata: {
          endo: {
            type: COMPACTION_FRAME_TYPE,
            summary: `compacted: ${firstLine.slice(0, 160)}`,
            payload: { summary, framesBefore },
            at: Date.now(),
          },
        },
      });
    },
    historyLength,
    async reconfigure(patch) {
      if (patch.instructions !== undefined) instructions = patch.instructions;
      if (patch.executor !== undefined) executor = patch.executor;
      if (patch.tools !== undefined) tools = patch.tools;
      if (patch.commands !== undefined) commands = patch.commands;
      await rebuild();
    },
    self() {
      const serialized = serializeInstance(machine.instance, charter);
      return serialized.children?.find((c) => (typeof c.node === "string" ? c.node : c.node.key) === SELF_NODE_KEY);
    },
    close() {
      store.close();
    },
  };
}

/** The endograph payload of a stored frame (rides in metadata.endo.payload). */
export function endoPayloadOf(frame: Frame): Record<string, unknown> | undefined {
  const payload = (frame.payload as { metadata?: { endo?: { payload?: Record<string, unknown> } } } | undefined)
    ?.metadata?.endo?.payload;
  return payload && typeof payload === "object" ? payload : undefined;
}

/** Frames the machine records itself (tool calls, commands, the model's text) get a type from their first message. */
function frameTypeOf(frame: ProjectorFrame): string {
  const first = frame.messages[0];
  if (!first) return "machine";
  if (first.type === "action") {
    if (first.action === "command") return first.kind === "request" ? "call" : "outcome";
    return "tool";
  }
  if (first.type === "assistant") return "judgment";
  if (first.type === "instance" && first.kind === "state.update") return first.stateKey === WORLD_STATE_KEY ? "world" : "state";
  if (first.type === "instance") return "evolve";
  return "machine";
}

function describeFrame(frame: ProjectorFrame): string {
  const first = frame.messages[0];
  if (!first) return "(empty frame)";
  if ("text" in first && typeof first.text === "string") return first.text;
  if (first.type === "action") {
    if (first.kind === "request") return `${first.action === "command" ? "call" : "call"}: ${first.name} ${JSON.stringify(first.input)?.slice(0, 200) ?? ""}`;
    const value = first.value;
    const shown = typeof value === "string" ? value : value && typeof value === "object" && "summary" in value ? String((value as { summary: unknown }).summary) : first.error ?? "";
    return `${first.name}: ${first.success ? "" : "FAILED "}${shown.split("\n")[0]?.slice(0, 200) ?? ""}`;
  }
  if (first.type === "work") return `work/${first.kind}`;
  if (first.type === "instance" && first.kind === "state.update") {
    const update = first.update as { op?: string; value?: unknown };
    const keys = update.op === "patch" && update.value && typeof update.value === "object" ? Object.keys(update.value as object) : [];
    return `${first.stateKey} ${update.op ?? "updated"}${keys.length ? `: ${keys.join(", ")}` : ""}`;
  }
  if (first.type === "instance" && first.kind === "transition") return `self reshaped (${first.instanceId})`;
  if (first.type === "instance" && first.kind === "spawn") return `spawned ${first.children.map((c) => (typeof c.node === "string" ? c.node : c.node.key)).join(", ")} under ${first.parentInstanceId}`;
  if (first.type === "instance" && first.kind === "remove") return `${first.reason ?? "removed"} ${first.instanceId}`;
  return `${first.type} frame`;
}
