import type { Verb } from "../core/types.ts";
import type { Inbox } from "../inbox/inbox.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { FrameInput } from "../store/types.ts";
import type { WorldEntry } from "../world/model.ts";

export interface JudgeContext {
  verbs: Map<string, Verb>;
  projectDir: string;
  agentDir: string;
  playbookDir: string;
  /** Current playbook (getter: rules written mid-activation apply). */
  playbook: () => PlaybookEntry[];
  /** Called after a playbook write so the loop picks up new rules. */
  onPlaybookChanged: () => Promise<void>;
  /** Record a frame, optionally folding world-entry changes into it. */
  record: (
    input: Omit<FrameInput, "at"> & { at?: number },
    entries?: Record<string, WorldEntry | null>,
  ) => void;
  /** Present when the agent is supervising (has an inbox to answer). */
  inbox?: Inbox;
}

/**
 * Late-bound context for the judgment layer's tools. Charter actions are
 * created before the world exists (the charter needs the tool registry at
 * build time), so tools reach their runtime dependencies through this
 * mutable holder, bound once wiring is complete.
 */
export class JudgeRuntime {
  private bound?: JudgeContext;
  private compaction?: string;

  bind(context: JudgeContext): void {
    this.bound = context;
  }

  /** The compact tool asks; the session runner compacts once the activation ends. */
  requestCompaction(summary: string): void {
    this.compaction = summary;
  }

  takeCompactionRequest(): string | undefined {
    const summary = this.compaction;
    this.compaction = undefined;
    return summary;
  }

  get(): JudgeContext {
    if (!this.bound) {
      throw new Error("judge runtime not bound — tools invoked before wiring");
    }
    return this.bound;
  }
}
