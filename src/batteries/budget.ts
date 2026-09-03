import { createState, recencyRegion } from "@projectors/core";
import { z } from "zod";
import type { Battery } from "../agent/define.ts";
import { LateBound, type RuntimeContext } from "../agent/runtime.ts";
import { type ActivationTrigger } from "../judge/activate.ts";
import { SCRIPTED_REQUESTS_NOTE } from "../judge/prompts.ts";
import { allFrames, type Frame } from "../store/types.ts";
import { endoPayloadOf } from "../world/world.ts";

/**
 * The economy: dollars metered per activation into two envelopes,
 * projected into the model's context, warned at 75/90/95% — never
 * enforced. Opex is every activation a drift caused (a peer or the world
 * needed something); capex is every session (self-initiated: building
 * assets, research, learning). Capex is scheduled lazily: this battery's
 * own "capex" session after every N opex activations. Each day rolls into
 * a deterministic digest. The opex/capex vocabulary lives here and nowhere
 * else.
 */

export interface BudgetOptions {
  daily_usd?: number;
  envelopes?: { opex: number; capex: number };
  /** Capex session after every N opex activations; 0 = only on `endo capex`. Default 5. */
  capex_every?: number;
}

export const budgetStateSchema = z.object({
  date: z.string(),
  dailyUsd: z.number().nullable(),
  envelopes: z.object({ opex: z.number(), capex: z.number() }),
  spent: z.object({ opex: z.number(), capex: z.number() }),
  activations: z.object({ opex: z.number(), capex: z.number() }),
  warned: z.array(z.number()),
  // Projector schemas are validation-only (no defaults/transforms): every
  // write carries the whole state, so nothing is defaulted on read either.
  opexSinceCapex: z.number().int().nonnegative(),
});
export type BudgetState = z.infer<typeof budgetStateSchema>;
export type Envelope = "opex" | "capex";

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const FALLBACK_PRICE = PRICES["claude-opus-5"]!;
const CACHE_READ_FACTOR = 0.1;
export const WARN_THRESHOLDS = [75, 90, 95];
const STATE_KEY = "budget";

export function envelopeOf(trigger: ActivationTrigger): Envelope {
  return trigger.kind === "session" ? "capex" : "opex";
}

/** History length at which the capex session is told to compact first. */
export const COMPACT_AT_FRAMES = 120;

export function capexReport(ask?: string, historyLength?: number): string {
  const lines = [
    `Research session (capex).`,
    ``,
    `This is an opportunity, not an assignment. The expected outcome, most`,
    `of the time, is NOTHING: you resolve immediately with "nothing worth`,
    `building" and spend no tool calls. Act only on a concrete pattern you`,
    `can point to in the frames in front of you — the same request class`,
    `judged three or more times, a rule that failed because of a bug in the`,
    `rule, a procedure you keep patching by hand, a question peers keep`,
    `asking that a rule or an exposed procedure could answer. Do not re-read`,
    `the playbook or the project looking for things to improve; do not`,
    `polish rules that work; do not write rules for cases that have not`,
    `happened. A no-op session is the sign of a healthy agent.`,
    ``,
  ];
  if (ask) lines.push(`The owner asked for this session specifically: ${ask}`, `An explicit ask overrides the default: do what was asked.`, ``);
  if (historyLength != null && historyLength >= COMPACT_AT_FRAMES) {
    lines.push(
      `Exception that is always worth doing: your visible history is`,
      `${historyLength} frames. Call compact with a summary a successor could`,
      `work from (what you tend and its state, open work, what peers ask and`,
      `how you handle it, lessons). Then apply the rule above.`,
      ``,
    );
  }
  lines.push(
    `If you do build something: rules match with a plain regex against the`,
    `drift summary and observed output — check it against the actual text`,
    `in past incidents with try_rule. Mandate or declaration changes are`,
    `proposals in prose for the owner, never edits: you write only under src.`,
    ``,
    SCRIPTED_REQUESTS_NOTE,
    ``,
    `Close with resolve: either "nothing worth building" or the assets`,
    `produced. Escalate only if something is broken and you cannot fix it.`,
  );
  return lines.join("\n");
}

export function localDate(at = Date.now()): string {
  return new Date(at).toLocaleDateString("en-CA");
}

export function costUsd(model: string | undefined, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }, granted?: { input: number; output: number }) {
  const price = granted ?? (model ? PRICES[model] : undefined);
  const rate = price ?? FALLBACK_PRICE;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);
  const usd = (uncached * rate.input + cached * rate.input * CACHE_READ_FACTOR + (usage.outputTokens ?? 0) * rate.output) / 1_000_000;
  return { usd, estimated: price === undefined };
}

export function budget(opts: BudgetOptions = {}): Battery {
  const runtime = new LateBound<RuntimeContext>();
  const envelopes = opts.envelopes ?? { opex: 0.8, capex: 0.2 };
  const dailyUsd = opts.daily_usd ?? null;
  const capexEvery = opts.capex_every ?? 5;
  const empty: BudgetState = { date: "", dailyUsd, envelopes, spent: { opex: 0, capex: 0 }, activations: { opex: 0, capex: 0 }, warned: [], opexSinceCapex: 0 };
  const state = createState({
    key: STATE_KEY,
    schema: budgetStateSchema,
    init: empty,
    projection: {
      slot: recencyRegion,
      render: (value) => {
        const b = budgetStateSchema.safeParse(value);
        if (!b.success) return "Budget: unknown.";
        const warn = b.data.warned.length ? ` — WARNING: ${Math.max(...b.data.warned)}% of the allowance used, land the plane` : "";
        return `Budget today: ${describeBudget(b.data)}${warn}.`;
      },
    },
  });

  const current = (ctx: RuntimeContext, at = Date.now()): BudgetState => {
    const b = budgetStateSchema.parse(ctx.world.state<BudgetState>(STATE_KEY, empty));
    const today = localDate(at);
    return b.date === today ? b : { ...empty, date: today, opexSinceCapex: b.opexSinceCapex };
  };

  let capexQueued = false;

  return {
    name: "budget",
    states: [state],
    sessions: {
      capex: {
        description: "research session: compact, distill rules",
        prompt: (ask, ctx) => capexReport(ask, ctx.world.historyLength()),
      },
    },
    bind: (ctx) => runtime.bind(ctx),
    status: () => {
      if (!runtime.bound) return [];
      const b = current(runtime.get());
      return [{ subject: "budget", state: b.warned.length ? "yellow" : "green", summary: describeBudget(b) }];
    },
    hooks: {
      async afterActivation(outcome) {
        const ctx = runtime.get();
        const envelope = envelopeOf(outcome.trigger);
        let next = current(ctx);
        const usage = outcome.execution?.usage;
        if (usage) {
          const model = outcome.execution?.model ?? ctx.executorModel;
          const { usd, estimated } = costUsd(model, usage, model === ctx.executorModel ? ctx.executorPrice : undefined);
          next = {
            ...next,
            spent: { ...next.spent, [envelope]: next.spent[envelope] + usd },
            activations: { ...next.activations, [envelope]: next.activations[envelope] + 1 },
            warned: [...next.warned],
          };
          const warnings: number[] = [];
          if (next.dailyUsd != null && next.dailyUsd > 0) {
            const pct = (totalSpent(next) / next.dailyUsd) * 100;
            for (const t of WARN_THRESHOLDS) if (pct >= t && !next.warned.includes(t)) (next.warned.push(t), warnings.push(t));
          }
          const tokens = `${fmtK(usage.inputTokens)} in / ${fmtK(usage.outputTokens)} out${usage.cachedInputTokens ? ` / ${fmtK(usage.cachedInputTokens)} cached` : ""}`;
          ctx.world.recordState(
            {
              type: "spend",
              summary: `${envelope} $${usd.toFixed(3)}${estimated ? " (est.)" : ""} — ${model ?? "unknown model"}, ${tokens} — ${describeBudget(next)}`,
              payload: { usd, envelope, model, usage, estimated, trigger: outcome.trigger },
              incident: outcome.trigger.incident,
              at: Date.now(),
            },
            STATE_KEY,
            next,
          );
          for (const t of warnings) {
            ctx.record({ type: "budget", summary: `budget warning: ${t}% of today's $${next.dailyUsd!.toFixed(2)} allowance used — pace yourself`, payload: { threshold: t } });
          }
        }
        // Lazy capex: paced by the workload, never the clock.
        if (envelope === "opex") {
          const count = next.opexSinceCapex + 1;
          const due = capexEvery > 0 && count >= capexEvery;
          ctx.world.recordState(
            { type: "budget", summary: due ? `capex due: ${count} opex activations since the last session` : `opex activations since capex: ${count}/${capexEvery || "∞"}`, at: Date.now() },
            STATE_KEY,
            { ...next, opexSinceCapex: due ? 0 : count },
          );
          if (due && !capexQueued) {
            capexQueued = true;
            void ctx
              .session("capex")
              .catch((err) => ctx.record({ type: "error", subject: "capex", summary: `capex session failed: ${err instanceof Error ? err.message : err}` }))
              .finally(() => (capexQueued = false));
          }
        } else {
          ctx.world.recordState({ type: "budget", summary: `${describeSession(outcome.trigger)} done; opex counter reset`, at: Date.now() }, STATE_KEY, { ...next, opexSinceCapex: 0 });
        }
      },
      tick(now) {
        const ctx = runtime.get();
        const b = budgetStateSchema.parse(ctx.world.state<BudgetState>(STATE_KEY, empty));
        const today = localDate(now);
        if (b.date && b.date !== today) {
          const digest = computeDigest([...allFrames(ctx.store)], b.date);
          ctx.record({ type: "digest", subject: `digest:${b.date}`, summary: renderDigest(digest).split("\n")[0]!, payload: digest });
          ctx.world.recordState({ type: "budget", summary: `new day ${today}: ${describeBudget({ ...empty, date: today })}`, at: now }, STATE_KEY, { ...empty, date: today, opexSinceCapex: b.opexSinceCapex });
        }
      },
    },
    commands: [
      {
        name: "digest",
        description: "the day's account: drift, rules, judgment, spend",
        async run(args, ctx) {
          const date = args[0] ?? localDate();
          console.log(renderDigest(computeDigest([...allFrames(ctx.store)], date)));
          return 0;
        },
      },
    ],
  };
}

function describeSession(t: ActivationTrigger): string {
  return t.kind === "session" ? `${t.session} session` : "session";
}

export function totalSpent(b: BudgetState): number {
  return b.spent.opex + b.spent.capex;
}

export function describeBudget(b: BudgetState): string {
  const total = totalSpent(b);
  const parts = `opex $${b.spent.opex.toFixed(2)}, capex $${b.spent.capex.toFixed(2)}`;
  if (b.dailyUsd == null) return `$${total.toFixed(2)} spent today (${parts}; no allowance)`;
  return `$${total.toFixed(2)} of $${b.dailyUsd.toFixed(2)} today (${Math.round((total / b.dailyUsd) * 100)}%; ${parts})`;
}

function fmtK(n: number | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}

export interface Digest {
  date: string;
  frames: number;
  drifts: number;
  incidents: number;
  ruleFirings: Record<string, number>;
  calls: number;
  judgments: number;
  escalations: string[];
  spend: { opex: number; capex: number; activations: number };
  warnings: number;
}

export function computeDigest(frames: Frame[], date: string): Digest {
  const day = frames.filter((f) => localDate(f.at) === date);
  const d: Digest = {
    date,
    frames: day.length,
    drifts: 0,
    incidents: new Set(day.map((f) => f.incident).filter(Boolean)).size,
    ruleFirings: {},
    calls: 0,
    judgments: 0,
    escalations: [],
    spend: { opex: 0, capex: 0, activations: 0 },
    warnings: 0,
  };
  for (const frame of day) {
    const payload = endoPayloadOf(frame);
    switch (frame.type) {
      case "drift":
        d.drifts++;
        break;
      case "call":
        d.calls++;
        break;
      case "action": {
        const rule = typeof payload?.rule === "string" ? payload.rule : "(unknown)";
        d.ruleFirings[rule] = (d.ruleFirings[rule] ?? 0) + 1;
        break;
      }
      case "activation":
        d.judgments++;
        break;
      case "escalation":
        d.escalations.push(frame.summary);
        break;
      case "spend": {
        const envelope = payload?.envelope === "capex" ? "capex" : "opex";
        d.spend[envelope] += typeof payload?.usd === "number" ? payload.usd : 0;
        d.spend.activations++;
        break;
      }
      case "budget":
        if (typeof payload?.threshold === "number") d.warnings++;
        break;
    }
  }
  return d;
}

export function renderDigest(d: Digest): string {
  const rules = Object.entries(d.ruleFirings).sort((a, b) => b[1] - a[1]);
  return [
    `digest ${d.date}: ${d.frames} frames, ${d.drifts} drifts, ${d.calls} calls across ${d.incidents} incidents`,
    `  rules fired: ${rules.length ? rules.map(([n, c]) => `${n}×${c}`).join(", ") : "none"}`,
    `  judgment: ${d.judgments} activations, ${d.escalations.length} escalated${d.warnings ? `, ${d.warnings} budget warning(s)` : ""}`,
    `  spend: $${(d.spend.opex + d.spend.capex).toFixed(2)} (opex $${d.spend.opex.toFixed(2)}, capex $${d.spend.capex.toFixed(2)})`,
    ...d.escalations.map((e) => `  ! ${e}`),
  ].join("\n");
}
