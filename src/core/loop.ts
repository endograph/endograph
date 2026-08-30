import { matchRule } from "../playbook/match.ts";
import { runRule } from "../playbook/run.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { World } from "../world/world.ts";
import type { Drift, Sensor, Verb, VerbResult } from "./types.ts";

/**
 * The universal loop — the deterministic 99%:
 *
 *   sense → diff → playbook match?
 *     yes → act deterministically
 *     no  → activate LLM → judge → act-under-charter | escalate
 *   → record → settle
 *
 * Every drift is settled exactly once with how it was handled, so a sensor
 * relaying a peer's request can always answer it.
 */

export interface LoopOptions {
  world: World;
  sensors: Sensor[];
  /** World-model verbs available to rules; empty for charter-only agents. */
  verbs?: Map<string, Verb>;
  /** Getter so rules written mid-flight (by the judgment layer) apply. */
  playbook: () => PlaybookEntry[];
  projectDir: string;
  agentDir: string;
  /** The judgment layer seam; returns the judgment's outcome. */
  onUnmatched?: (drift: Drift, incident: string, context?: JudgeContext) => Promise<VerbResult | void>;
  /** Snapshot cadence; also the status surface's freshness signal. */
  snapshotIntervalMs?: number;
}

/** Why judgment was asked for beyond "no rule matched". */
export interface JudgeContext {
  ruleFailure?: { rule: string; result: VerbResult };
}

const ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000;

export class Loop {
  private opts: LoopOptions;
  private stopped = false;
  private cooldowns = new Map<string, number>();
  private activationCooldowns = new Map<string, number>();
  private timers: Timer[] = [];
  private verbs: Map<string, Verb>;

  constructor(opts: LoopOptions) {
    this.opts = opts;
    this.verbs = opts.verbs ?? new Map();
  }

  /** Start sensor polling and the snapshot heartbeat. Non-blocking. */
  start(): void {
    for (const sensor of this.opts.sensors) {
      this.schedule(sensor);
    }
    const interval = this.opts.snapshotIntervalMs ?? 20_000;
    this.timers.push(setInterval(() => this.opts.world.snapshot(), interval));
    this.opts.world.snapshot();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.opts.world.snapshot();
  }

  private schedule(sensor: Sensor): void {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || this.stopped) return;
      busy = true;
      try {
        const drifts = await sensor.poll();
        for (const drift of drifts) {
          await this.handle(drift);
        }
      } catch (err) {
        this.opts.world.record({
          type: "error",
          subject: `sensor:${sensor.name}`,
          summary: `sensor ${sensor.name} failed: ${String(err)}`,
          at: Date.now(),
        });
      } finally {
        busy = false;
      }
    }, sensor.intervalMs);
    this.timers.push(timer);
  }

  async handle(drift: Drift): Promise<void> {
    const result = await this.dispatch(drift);
    if (result.pending) return; // a background job owns the answer now
    try {
      drift.settle?.(result);
    } catch (err) {
      this.opts.world.record({
        type: "error",
        subject: drift.subject,
        summary: `settle failed: ${err instanceof Error ? err.message : err}`,
        incident: drift.incident,
        at: Date.now(),
      });
    }
  }

  private async dispatch(drift: Drift): Promise<VerbResult> {
    const incident = drift.incident ?? `inc-${crypto.randomUUID().slice(0, 8)}`;
    const { world } = this.opts;
    world.record({
      type: "drift",
      subject: drift.subject,
      summary: `[${drift.kind}] ${drift.summary}`,
      payload: { kind: drift.kind, detail: drift.detail, data: drift.data },
      incident,
      at: drift.observedAt,
    });

    const rule = matchRule(this.opts.playbook(), drift);
    if (!rule) return this.judge(drift, incident, {});

    const cooldownKey = `${rule.name}:${drift.subject}`;
    const last = this.cooldowns.get(cooldownKey) ?? 0;
    if (Date.now() - last < rule.cooldownSeconds * 1000) {
      const summary = `rule ${rule.name} in cooldown; drift not re-handled`;
      world.record({
        type: "note",
        subject: drift.subject,
        summary,
        incident,
        at: Date.now(),
      });
      return { ok: false, summary };
    }
    this.cooldowns.set(cooldownKey, Date.now());

    world.record({
      type: "action",
      subject: drift.subject,
      summary: `rule ${rule.name} matched [${drift.kind}]`,
      payload: { rule: rule.name, provenance: rule.provenance },
      incident,
      at: Date.now(),
    });
    const result = await runRule(rule, drift, {
      projectDir: this.opts.projectDir,
      agentDir: this.opts.agentDir,
      verbs: this.verbs,
    });
    world.record({
      type: "outcome",
      subject: drift.subject,
      summary: `rule ${rule.name}: ${result.refused ? "refused — " : result.pending ? "in progress — " : ""}${result.summary}`,
      payload: { ok: result.ok, refused: result.refused ?? false, pending: result.pending ?? false, detail: result.detail },
      incident,
      at: Date.now(),
    });
    if (!result.ok && !result.refused && rule.onFailure === "judge" && this.opts.onUnmatched) {
      return this.judge(drift, incident, { ruleFailure: { rule: rule.name, result } });
    }
    return result;
  }

  private async judge(drift: Drift, incident: string, context: JudgeContext): Promise<VerbResult> {
    const { world } = this.opts;
    if (!this.opts.onUnmatched) {
      const summary = context.ruleFailure
        ? `rule ${context.ruleFailure.rule} failed; judgment layer not enabled`
        : `no playbook rule for [${drift.kind}]; judgment layer not enabled`;
      world.record({ type: "escalation", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
    // A persistent condition must not re-wake the model every poll:
    // one activation per drift class per subject per window.
    const key = `${drift.kind}:${drift.subject}`;
    const last = this.activationCooldowns.get(key) ?? 0;
    if (Date.now() - last < ACTIVATION_COOLDOWN_MS) {
      const summary = `[${drift.kind}] recurring; activation in cooldown`;
      world.record({ type: "note", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
    this.activationCooldowns.set(key, Date.now());
    try {
      const outcome = await this.opts.onUnmatched(drift, incident, context);
      return outcome ?? { ok: true, summary: "judged" };
    } catch (err) {
      // The judgment layer failing must never stop supervision.
      const summary = `judgment layer failed: ${err instanceof Error ? err.message : err}`;
      world.record({ type: "escalation", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
  }
}
