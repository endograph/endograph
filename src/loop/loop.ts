import { matchRule } from "../playbook/match.ts";
import { runRule, type ScriptContext } from "../playbook/run.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { World } from "../world/world.ts";
import type { Drift, Outcome, Sensor } from "./types.ts";

/**
 * The universal loop — the deterministic 99%:
 *
 *   sense → diff → rule match?
 *     yes → act deterministically
 *     no  → judge → act-under-mandate | escalate
 *   → record → settle
 *
 * Every drift is settled exactly once with how it was handled.
 */

export interface JudgeContext {
  ruleFailure?: { rule: string; result: Outcome };
}

export interface LoopOptions {
  world: World;
  sensors: Sensor[];
  /** Getter: rules written mid-flight apply. */
  playbook: () => PlaybookEntry[];
  scripts: ScriptContext;
  /** The judgment seam. Absent: unmatched drift is recorded as an escalation. */
  judge?: (drift: Drift, incident: string, context: JudgeContext) => Promise<Outcome | void>;
  /** Observe settlements (batteries: rule statistics, digests). */
  onSettle?: (drift: Drift, outcome: Outcome) => void;
  snapshotIntervalMs?: number;
}

const ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000;

export function newIncident(): string {
  return `inc-${crypto.randomUUID().slice(0, 8)}`;
}

export class Loop {
  private stopped = false;
  private cooldowns = new Map<string, number>();
  private activationCooldowns = new Map<string, number>();
  private timers: Timer[] = [];

  constructor(private opts: LoopOptions) {}

  /** Start sensor polling and the snapshot heartbeat. Non-blocking. */
  start(): void {
    for (const sensor of this.opts.sensors) this.schedule(sensor);
    this.timers.push(setInterval(() => this.opts.world.snapshot(), this.opts.snapshotIntervalMs ?? 20_000));
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
        for (const drift of await sensor.poll()) await this.handle(drift);
      } catch (err) {
        this.opts.world.record({
          type: "error",
          subject: `sensor:${sensor.name}`,
          summary: `sensor ${sensor.name} failed: ${err instanceof Error ? err.message : err}`,
          at: Date.now(),
        });
      } finally {
        busy = false;
      }
    }, sensor.intervalMs);
    this.timers.push(timer);
  }

  async handle(drift: Drift): Promise<void> {
    const outcome = await this.dispatch(drift);
    if (outcome.pending) return; // a background job owns the answer now
    try {
      drift.settle?.(outcome);
    } catch (err) {
      this.opts.world.record({
        type: "error",
        subject: drift.subject,
        summary: `settle failed: ${err instanceof Error ? err.message : err}`,
        incident: drift.incident,
        at: Date.now(),
      });
    }
    this.opts.onSettle?.(drift, outcome);
  }

  private async dispatch(drift: Drift): Promise<Outcome> {
    const incident = drift.incident ?? newIncident();
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
    if (Date.now() - (this.cooldowns.get(cooldownKey) ?? 0) < rule.cooldownSeconds * 1000) {
      const summary = `rule ${rule.name} in cooldown; drift not re-handled`;
      world.record({ type: "note", subject: drift.subject, summary, incident, at: Date.now() });
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
    const result = await runRule(rule, drift, this.opts.scripts);
    world.record({
      type: "outcome",
      subject: drift.subject,
      summary: `rule ${rule.name}: ${result.refused ? "refused — " : result.pending ? "in progress — " : ""}${result.summary}`,
      payload: { rule: rule.name, ok: result.ok, refused: result.refused ?? false, pending: result.pending ?? false, detail: result.detail },
      incident,
      at: Date.now(),
    });
    if (!result.ok && !result.refused && rule.onFailure === "judge" && this.opts.judge) {
      return this.judge(drift, incident, { ruleFailure: { rule: rule.name, result } });
    }
    return result;
  }

  private async judge(drift: Drift, incident: string, context: JudgeContext): Promise<Outcome> {
    const { world } = this.opts;
    if (!this.opts.judge) {
      const summary = context.ruleFailure
        ? `rule ${context.ruleFailure.rule} failed; no judgment layer`
        : `no rule for [${drift.kind}]; no judgment layer`;
      world.record({ type: "escalation", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
    // A persistent condition must not re-wake the model every poll.
    const key = `${drift.kind}:${drift.subject}`;
    if (Date.now() - (this.activationCooldowns.get(key) ?? 0) < ACTIVATION_COOLDOWN_MS) {
      const summary = `[${drift.kind}] recurring; activation in cooldown`;
      world.record({ type: "note", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
    this.activationCooldowns.set(key, Date.now());
    try {
      return (await this.opts.judge(drift, incident, context)) ?? { ok: true, summary: "judged" };
    } catch (err) {
      // Judgment failing must never stop the loop.
      const summary = `judgment failed: ${err instanceof Error ? err.message : err}`;
      world.record({ type: "escalation", subject: drift.subject, summary, incident, at: Date.now() });
      return { ok: false, summary };
    }
  }
}
