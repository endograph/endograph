import { z } from "zod";
import type { AgentConfig } from "../agent/config.ts";

/**
 * The budget: a soft daily dollar allowance split into named envelopes,
 * metered per activation reason. The runtime meters, projects, and warns —
 * it never enforces. Hard stop-loss belongs to the platform layer (API
 * spend caps); a runtime kill switch fires at the worst moment by
 * construction.
 *
 * - opex:  demand-driven run-the-system work (monitoring, diagnosis,
 *          repair, reporting).
 * - capex: discretionary asset-building (drafting/back-testing playbook
 *          rules, prototyping). Produces proposals and reviewable assets.
 */
export const budgetStateSchema = z.object({
  /** Local calendar day this state covers, YYYY-MM-DD; "" before first use. */
  date: z.string(),
  /** Daily allowance from the grant; null = metering without an allowance. */
  dailyUsd: z.number().nullable(),
  /** Envelope split as fractions of the daily allowance. */
  envelopes: z.object({ opex: z.number(), capex: z.number() }),
  spent: z.object({ opex: z.number(), capex: z.number() }),
  activations: z.object({ opex: z.number(), capex: z.number() }),
  /** Thresholds (percent) already warned today, e.g. [75, 90]. */
  warned: z.array(z.number()),
  lastCapexDate: z.string().nullable(),
  /** Opex activations since the last capex session (the lazy scheduler's counter). */
  opexSinceCapex: z.number().int().nonnegative().default(0),
});

export type BudgetState = z.infer<typeof budgetStateSchema>;

export const EMPTY_BUDGET: BudgetState = {
  date: "",
  dailyUsd: null,
  envelopes: { opex: 0.8, capex: 0.2 },
  spent: { opex: 0, capex: 0 },
  activations: { opex: 0, capex: 0 },
  warned: [],
  lastCapexDate: null,
  opexSinceCapex: 0,
};

export type Envelope = "opex" | "capex";

/** Activation reasons are "envelope:cause", e.g. "opex:drift". */
export function envelopeOf(reason: string): Envelope {
  return reason.startsWith("capex") ? "capex" : "opex";
}

export function localDate(at = Date.now()): string {
  return new Date(at).toLocaleDateString("en-CA");
}

/** Fresh budget for `date`, seeded from the grant; carries capex marker. */
export function freshBudget(
  config: AgentConfig,
  date: string,
  previous?: BudgetState,
): BudgetState {
  return {
    date,
    dailyUsd: config.budget.daily_usd ?? null,
    envelopes: config.budget.envelopes,
    spent: { opex: 0, capex: 0 },
    activations: { opex: 0, capex: 0 },
    warned: [],
    lastCapexDate: previous?.lastCapexDate ?? null,
    opexSinceCapex: previous?.opexSinceCapex ?? 0,
  };
}

/**
 * The grant changed while the day was in progress: carry spend and counters,
 * take allowance and envelopes from the new grant. Null when nothing differs.
 */
export function reseedBudget(config: AgentConfig, budget: BudgetState): BudgetState | null {
  const dailyUsd = config.budget.daily_usd ?? null;
  const { opex, capex } = config.budget.envelopes;
  if (
    budget.dailyUsd === dailyUsd &&
    budget.envelopes.opex === opex &&
    budget.envelopes.capex === capex
  ) {
    return null;
  }
  return { ...budget, dailyUsd, envelopes: { opex, capex }, warned: [] };
}

export function totalSpent(budget: BudgetState): number {
  return budget.spent.opex + budget.spent.capex;
}

export function describeBudget(budget: BudgetState): string {
  const total = totalSpent(budget);
  const parts = `opex $${budget.spent.opex.toFixed(2)}, capex $${budget.spent.capex.toFixed(2)}`;
  if (budget.dailyUsd == null) {
    return `$${total.toFixed(2)} spent today (${parts}; no daily allowance set)`;
  }
  const pct = Math.round((total / budget.dailyUsd) * 100);
  return `$${total.toFixed(2)} of $${budget.dailyUsd.toFixed(2)} today (${pct}%; ${parts})`;
}
