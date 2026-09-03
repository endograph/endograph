import type { ActivationOutcome } from "../judge/activate.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { ScriptContext } from "../playbook/run.ts";
import type { FrameInput, FrameStore } from "../store/types.ts";
import type { WorldPatch } from "../world/model.ts";
import type { World } from "../world/world.ts";
import type { HomePaths } from "./home.ts";

/**
 * What a running agent hands its batteries at bind time. Tools are created
 * when the declaration is imported — before the store, world, or home
 * exist — so batteries reach the runtime through a late binding.
 */
export interface RuntimeContext {
  name: string;
  home: HomePaths;
  scripts: ScriptContext;
  store: FrameStore;
  world: World;
  /** Current playbook (getter: entries written mid-activation apply). */
  playbook: () => PlaybookEntry[];
  reloadPlaybook: () => Promise<void>;
  record: (input: Omit<FrameInput, "at"> & { at?: number }, patch?: WorldPatch) => void;
  /**
   * Run a standing session by name (queued behind the current activation).
   * Batteries declare sessions and start their own; the owner starts any.
   */
  session: (name: string, ask?: string) => Promise<ActivationOutcome>;
  /** The compact tool asks; the runtime compacts once the activation ends. */
  requestCompaction: (summary: string) => void;
  /** What the executor spec declared, for metering. */
  executorModel?: string;
  executorPrice?: { input: number; output: number };
}

/** A holder a battery's tools close over; bound once wiring completes. */
export class LateBound<T> {
  private value?: T;
  bind(value: T): void {
    this.value = value;
  }
  get(): T {
    if (!this.value) throw new Error("runtime not bound — tool invoked before wiring");
    return this.value;
  }
  get bound(): boolean {
    return this.value !== undefined;
  }
}
