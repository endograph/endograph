import type { ExecutionReport } from "@projectors/core";
import type { AgentConfig } from "../agent/config.ts";
import type { World } from "../world/world.ts";
import {
  envelopeOf,
  freshBudget,
  localDate,
  totalSpent,
  type BudgetState,
} from "./budget.ts";

/**
 * Metering. Primary currency is dollars — tokens don't compare across
 * models. Prices are USD per million tokens (Anthropic first-party rates);
 * an unknown model is priced at the Opus rate and flagged as an estimate.
 * Soft by design: this records and warns, it never blocks.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const FALLBACK_PRICE = PRICES["claude-opus-5"]!;
const CACHE_READ_FACTOR = 0.1;
export const WARN_THRESHOLDS = [75, 90, 95];

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export function costUsd(
  model: string,
  usage: Usage,
  granted?: { input: number; output: number },
): { usd: number; estimated: boolean } {
  const price = granted ?? PRICES[model];
  const rate = price ?? FALLBACK_PRICE;
  // Providers report input tokens inclusive of cache reads; bill the cached
  // share at the cache rate and only the remainder at full price.
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);
  const usd =
    (uncached * rate.input +
      cached * rate.input * CACHE_READ_FACTOR +
      (usage.outputTokens ?? 0) * rate.output) /
    1_000_000;
  return { usd, estimated: price === undefined };
}

/** Today's budget, rolling over (and re-seeding from the grant) on a new day. */
export function currentBudget(world: World, config: AgentConfig, at = Date.now()): BudgetState {
  const today = localDate(at);
  const budget = world.budget();
  return budget.date === today ? budget : freshBudget(config, today, budget);
}

/**
 * Record one activation's spend against its envelope, fold the new balance
 * into the projected budget state, and warn once per threshold per day.
 */
export function recordSpend(
  world: World,
  config: AgentConfig,
  opts: { reason: string; execution?: ExecutionReport; incident?: string },
): { usd: number; budget: BudgetState } | undefined {
  const usage = opts.execution?.usage;
  if (!usage) return undefined;
  const model = opts.execution?.model ?? config.model.model;
  const { usd, estimated } = costUsd(
    model,
    usage,
    model === config.model.model ? config.model.price : undefined,
  );
  const envelope = envelopeOf(opts.reason);
  const budget = currentBudget(world, config);

  const next: BudgetState = {
    ...budget,
    spent: { ...budget.spent, [envelope]: budget.spent[envelope] + usd },
    activations: {
      ...budget.activations,
      [envelope]: budget.activations[envelope] + 1,
    },
    warned: [...budget.warned],
  };

  const newWarnings: number[] = [];
  if (next.dailyUsd != null && next.dailyUsd > 0) {
    const pct = (totalSpent(next) / next.dailyUsd) * 100;
    for (const threshold of WARN_THRESHOLDS) {
      if (pct >= threshold && !next.warned.includes(threshold)) {
        next.warned.push(threshold);
        newWarnings.push(threshold);
      }
    }
  }

  const tokens = `${fmtK(usage.inputTokens)} in / ${fmtK(usage.outputTokens)} out` +
    (usage.cachedInputTokens ? ` / ${fmtK(usage.cachedInputTokens)} cached` : "");
  const balance =
    next.dailyUsd != null
      ? `day $${totalSpent(next).toFixed(2)}/$${next.dailyUsd.toFixed(2)}`
      : `day $${totalSpent(next).toFixed(2)}`;
  world.recordBudget(
    {
      type: "spend",
      summary: `${envelope} $${usd.toFixed(3)}${estimated ? " (est.)" : ""} — ${model}, ${tokens} — ${balance}`,
      payload: { usd, envelope, model, usage, estimated, reason: opts.reason },
      incident: opts.incident,
      at: Date.now(),
    },
    next,
  );

  for (const threshold of newWarnings) {
    world.record({
      type: "budget",
      summary: `budget warning: ${threshold}% of today's $${next.dailyUsd!.toFixed(2)} allowance used ` +
        `(opex $${next.spent.opex.toFixed(2)}, capex $${next.spent.capex.toFixed(2)}) — pace yourself`,
      payload: { threshold, spent: next.spent, dailyUsd: next.dailyUsd },
      at: Date.now(),
    });
  }
  return { usd, budget: next };
}

function fmtK(n: number | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}
