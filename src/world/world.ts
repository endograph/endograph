import {
  createCharter,
  createMachine,
  createNode,
  createSourceInstance,
  createState,
  hydrateInstance,
  recencyRegion,
  replaceState,
  resolveStates,
  serializeInstance,
  type AnyAction,
  type Charter,
  type Frame as ProjectorFrame,
  type FrameMessage,
  type Machine,
  type ProjectorExecutor,
} from "@projectors/core";
import { budgetStateSchema, EMPTY_BUDGET, type BudgetState } from "../economy/budget.ts";
import type { Frame, FrameInput, FrameStore } from "../store/types.ts";
import { worldSchema, type WorldEntry, type WorldModel } from "./model.ts";

/**
 * The projector integration: world model + frame log persisted through the
 * machine. Every endograph frame (drift, action, outcome, note) is a projector
 * frame — the endograph envelope rides in frame.metadata.endo and is mirrored
 * into the store's columns for `sqlite3` queryability. World and budget
 * changes are durable `instance/state.update` messages, so the log alone
 * reproduces both; the snapshot is an optimization and the status surface.
 *
 * With no executor the machine is fold/replay/inspect only (all frames are
 * inert). With an executor + tools attached, a non-inert actor frame is an
 * activation: the judgment layer.
 *
 * Compaction: the machine's history begins at the latest `compaction` frame
 * — the model's own summary of everything before it. Older frames stay in
 * the store (endo why / replay / digest read the store), but the machine is
 * rebuilt from the compaction onward, so the model sees the summary plus
 * every frame since.
 */

const AGENT_INSTANCE_ID = "agent";
const NODE_KEY = "endo-agent";
export const COMPACTION_FRAME_TYPE = "compaction";

const worldState = createState({
  key: "world",
  schema: worldSchema,
  init: {},
  projection: { slot: recencyRegion },
});

/** Projected too: the model sees its balance and warnings every activation. */
const budgetState = createState({
  key: "budget",
  schema: budgetStateSchema,
  init: EMPTY_BUDGET,
  projection: { slot: recencyRegion },
});

const DEFAULT_INSTRUCTIONS =
  "You are an embedded agent tending a bounded domain. " +
  "The charter (mandate) is provided by the agent directory at activation time.";

export interface OpenWorldOptions {
  machineId?: string;
  /** System framing for activations; typically composed from charter.md. */
  instructions?: string;
  /** Model-callable tools (the judgment layer's verbs). */
  tools?: AnyAction[];
  executor?: ProjectorExecutor;
  /** Observe every recorded frame (the live terminal surface). */
  onFrame?: (input: FrameInput) => void;
}

function buildCharter(instructions: string, tools: AnyAction[]) {
  const agentNode = createNode({
    key: NODE_KEY,
    instructions,
    states: [worldState, budgetState],
    tools,
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
  const charter = createCharter({
    key: "endograph",
    version: "1",
    nodes: [agentNode],
    tools,
    commands: [],
    states: [worldState, budgetState],
  });
  return { agentNode, charter };
}

export interface World {
  /** Current converged world model. */
  world(): WorldModel;
  /** Current budget state (EMPTY_BUDGET before first metering). */
  budget(): BudgetState;
  /** Record a frame; optionally fold world-entry changes into the same frame. */
  record(input: FrameInput, entries?: Record<string, WorldEntry | null>): void;
  /** Record a frame carrying a budget state replacement. */
  recordBudget(input: FrameInput, next: BudgetState): void;
  /** Persist an instance snapshot at the current log position. */
  snapshot(): void;
  /**
   * Compact: record `summary` as the new beginning of the machine's history
   * and rebuild the machine from it. The store keeps everything.
   */
  compact(summary: string): void;
  /** Frames the machine currently holds (since the last compaction). */
  historyLength(): number;
  /**
   * Apply a new mandate or executor without losing anything: the machine is
   * rebuilt from the store under the new charter. Used when charter.md or
   * endograph.toml change while the agent is running.
   */
  reconfigure(patch: { instructions?: string; executor?: ProjectorExecutor }): void;
  /** The underlying projector machine — the judgment layer drives it. Rebuilt by compact(). */
  readonly machine: Machine;
  charter: Charter;
  close(): void;
}

export function openWorld(store: FrameStore, opts: OpenWorldOptions = {}): World {
  let instructions = opts.instructions ?? DEFAULT_INSTRUCTIONS;
  let executor = opts.executor;
  let { agentNode, charter } = buildCharter(instructions, opts.tools ?? []);
  let compactionSeq = lastFrameSeqOfType(store, COMPACTION_FRAME_TYPE);

  const build = (): Machine => {
    const snap = store.readSnapshot();
    let instance;
    let replayFrom = 0;
    if (snap) {
      instance = hydrateInstance(snap.state as never, charter);
      replayFrom = snap.asOfSeq;
    } else {
      instance = createSourceInstance({ id: AGENT_INSTANCE_ID, node: agentNode });
    }
    // History starts at the compaction frame: replay from just before it,
    // even if the snapshot is newer. State updates are replacements, so
    // re-applying frames the snapshot already folded is idempotent.
    if (compactionSeq != null && compactionSeq - 1 < replayFrom) {
      replayFrom = compactionSeq - 1;
    }
    resolveStates(instance);
    const machine: Machine = createMachine({
      id: opts.machineId ?? "endo",
      instance,
      charter,
      executor,
    });
    for (const stored of store.read(replayFrom)) {
      machine.enqueueFrame(stored.payload as ProjectorFrame);
    }
    // Persist from here on. Subscribing only after replay avoids re-appending.
    machine.subscribe((frame) => {
      const endo = (frame.metadata?.endo ?? {}) as Partial<FrameInput>;
      store.append({
        type: endo.type ?? "machine",
        subject: endo.subject,
        summary: endo.summary ?? describeFrame(frame),
        incident: endo.incident,
        at: endo.at ?? Date.now(),
        payload: frame,
      });
    });
    return machine;
  };

  let machine = build();

  const readState = <T>(key: string, fallback: T): T => {
    const resolved = resolveStates(machine.instance).find(
      (s) => s.descriptor.key === key,
    );
    return (resolved?.container.value as T | undefined) ?? fallback;
  };
  const readWorld = (): WorldModel => readState<WorldModel>("world", {});

  const enqueue = (input: FrameInput, extra: FrameMessage[], text?: string) => {
    opts.onFrame?.(input);
    machine.enqueueFrame({
      // Inert: observations never trigger work. The judgment layer
      // enqueues its own non-inert frames (see judge/activate.ts).
      inert: true,
      messages: [
        {
          type: "user",
          text: text ?? input.summary,
          actor: { id: `endo:${input.type}`, label: input.type },
        },
        ...extra,
      ],
      metadata: { endo: { ...input, payload: input.payload } },
    });
  };
  const stateUpdate = (stateKey: string, value: unknown): FrameMessage => ({
    type: "instance",
    kind: "state.update",
    instanceId: AGENT_INSTANCE_ID,
    stateKey,
    update: replaceState(value),
  });

  const writeSnapshot = () => {
    const last = store.lastSeq();
    store.writeSnapshot({
      asOfSeq: compactionSeq != null ? Math.min(last, compactionSeq - 1) : last,
      at: Date.now(),
      state: serializeInstance(machine.instance, charter),
    });
  };

  return {
    get machine() {
      return machine;
    },
    get charter() {
      return charter;
    },
    world: readWorld,
    // Parsed through the schema: state hydrated from an older snapshot may
    // predate a field, and defaults must apply rather than leak undefined.
    budget: () => budgetStateSchema.parse(readState<BudgetState>("budget", EMPTY_BUDGET)),

    record(input, entries) {
      const extra: FrameMessage[] = [];
      if (entries && Object.keys(entries).length > 0) {
        const next: WorldModel = { ...readWorld() };
        for (const [subject, entry] of Object.entries(entries)) {
          if (entry === null) delete next[subject];
          else next[subject] = entry;
        }
        extra.push(stateUpdate("world", next));
      }
      enqueue(input, extra);
    },

    recordBudget(input, next) {
      enqueue(input, [stateUpdate("budget", next)]);
    },

    snapshot: writeSnapshot,

    compact(summary) {
      const firstLine = summary.split("\n").find((l) => l.trim())?.trim() ?? "compaction";
      enqueue(
        {
          type: COMPACTION_FRAME_TYPE,
          summary: `compacted: ${firstLine.slice(0, 160)}`,
          payload: { summary, framesBefore: machine.frames.length },
          at: Date.now(),
        },
        [],
        `Summary of everything before this point (older frames are in the store, not in view):\n\n${summary}`,
      );
      compactionSeq = store.lastSeq();
      writeSnapshot();
      machine = build();
    },

    historyLength: () => machine.frames.length,

    reconfigure(patch) {
      if (patch.instructions !== undefined) instructions = patch.instructions;
      if (patch.executor !== undefined) executor = patch.executor;
      ({ agentNode, charter } = buildCharter(instructions, opts.tools ?? []));
      writeSnapshot();
      machine = build();
    },

    close() {
      store.close();
    },
  };
}

function lastFrameSeqOfType(store: FrameStore, type: string): number | null {
  let from = 0;
  let found: number | null = null;
  for (;;) {
    const batch = store.read(from, 1000);
    if (batch.length === 0) return found;
    for (const frame of batch) if (frame.type === type) found = frame.seq;
    from = batch[batch.length - 1]!.seq;
  }
}

/**
 * The store's payload column holds the full projector frame; the endograph
 * payload (drift detail, supervisor markers, rule names, spend) rides in
 * frame.metadata.endo.payload.
 */
export function endoPayloadOf(frame: Frame): Record<string, unknown> | undefined {
  const payload = (
    frame.payload as
      | { metadata?: { endo?: { payload?: Record<string, unknown> } } }
      | undefined
  )?.metadata?.endo?.payload;
  return payload && typeof payload === "object" ? payload : undefined;
}

function describeFrame(frame: ProjectorFrame): string {
  const first = frame.messages[0];
  if (!first) return "(empty frame)";
  if ("text" in first && typeof first.text === "string") return first.text;
  if (first.type === "action") {
    return `${first.kind === "request" ? "call" : "result"}: ${first.name}`;
  }
  if (first.type === "work") return `work/${first.kind}`;
  return `${first.type} frame`;
}
