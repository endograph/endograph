import { parseConfig } from "../src/agent/config.ts";
import { reseedBudget } from "../src/economy/budget.ts";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ExecutionReport } from "@projectors/core";
import { configSchema } from "../src/agent/config.ts";
import { rolloverBudget } from "../src/cli/up.ts";
import type { BudgetState } from "../src/economy/budget.ts";
import { envelopeOf, localDate } from "../src/economy/budget.ts";
import { computeDigest, renderDigest } from "../src/economy/digest.ts";
import { costUsd, recordSpend, type Usage } from "../src/economy/meter.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import type { FrameStore } from "../src/store/types.ts";
import { openWorld, endoPayloadOf } from "../src/world/world.ts";

const NOW = Date.parse("2026-05-15T19:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const config = () => configSchema.parse({ budget: { daily_usd: 1 } });

beforeEach(() => {
  setSystemTime(new Date(NOW));
});

afterEach(() => {
  setSystemTime();
});

function execution(usage: Usage, model = "claude-opus-5"): ExecutionReport {
  return { latencyMs: 1, model, usage };
}

function thresholdPayloads(store: FrameStore): number[] {
  return store
    .read(0)
    .filter((frame) => frame.type === "budget")
    .map((frame) => endoPayloadOf(frame)?.threshold)
    .filter((threshold): threshold is number => typeof threshold === "number");
}

function budgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    date: localDate(),
    dailyUsd: 1,
    envelopes: { opex: 0.8, capex: 0.2 },
    spent: { opex: 0, capex: 0 },
    activations: { opex: 0, capex: 0 },
    warned: [],
    lastCapexDate: null,
    opexSinceCapex: 0,
    ...overrides,
  };
}

function withoutConsoleLog(fn: () => void): void {
  const original = console.log;
  console.log = () => {};
  try {
    fn();
  } finally {
    console.log = original;
  }
}

describe("reseedBudget", () => {
  test("a changed grant replaces allowance and envelopes, keeps spend, clears warnings", () => {
    const budget = budgetState({ spent: { opex: 0.5, capex: 0.1 }, warned: [75] });
    const config = parseConfig("[budget.envelopes]\nopex = 0.5\ncapex = 0.5\n");
    expect(reseedBudget(config, budget)).toEqual({
      ...budget,
      dailyUsd: null,
      envelopes: { opex: 0.5, capex: 0.5 },
      warned: [],
    });
  });

  test("an unchanged grant is a no-op", () => {
    const budget = budgetState({ dailyUsd: 5, envelopes: { opex: 0.8, capex: 0.2 } });
    expect(reseedBudget(parseConfig("[budget]\ndaily_usd = 5.0\n"), budget)).toBeNull();
  });
});

describe("costUsd", () => {
  test("prices known models; input is inclusive of cache reads, billed at 0.1x", () => {
    // 2M input of which 1M came from cache: 1M × $3 + 1M × $0.30 + 1M × $15.
    const cost = costUsd("claude-sonnet-5", {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost.estimated).toBe(false);
    expect(cost.usd).toBeCloseTo(18.3, 10);
  });

  test("a granted price overrides the table", () => {
    const cost = costUsd(
      "gpt-something",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { input: 1, output: 2 },
    );
    expect(cost).toEqual({ usd: 3, estimated: false });
  });

  test("prices unknown models at the opus fallback rate and marks estimates", () => {
    const cost = costUsd("claude-unknown-1", {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost.estimated).toBe(true);
    expect(cost.usd).toBeCloseTo(30.5, 10);
  });

  test("zero usage costs zero", () => {
    expect(costUsd("claude-opus-5", {}).usd).toBe(0);
  });
});

describe("envelopeOf", () => {
  test("maps activation reason prefixes to budget envelopes", () => {
    expect(envelopeOf("opex:drift")).toBe("opex");
    expect(envelopeOf("capex:learn")).toBe("capex");
    expect(envelopeOf("other:reason")).toBe("opex");
  });
});

describe("recordSpend", () => {
  test("accumulates spend by envelope and appends spend frames", () => {
    const store = openMemoryStore();
    const world = openWorld(store);

    const opex = recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 400 }),
      incident: "inc-1",
    })!;
    const capex = recordSpend(world, config(), {
      reason: "capex:learn",
      execution: execution({ outputTokens: 800 }),
    })!;

    expect(opex.usd).toBeCloseTo(0.01, 10);
    expect(capex.usd).toBeCloseTo(0.02, 10);
    expect(world.budget().spent.opex).toBeCloseTo(0.01, 10);
    expect(world.budget().spent.capex).toBeCloseTo(0.02, 10);
    expect(world.budget().activations).toEqual({ opex: 1, capex: 1 });

    const spendFrames = store.read(0).filter((frame) => frame.type === "spend");
    expect(spendFrames).toHaveLength(2);
    expect(spendFrames[0]?.summary).toContain("opex");
    expect(spendFrames[0]?.incident).toBe("inc-1");
    expect(spendFrames[1]?.summary).toContain("capex");
  });

  test("records budget warnings once as thresholds are crossed", () => {
    const store = openMemoryStore();
    const world = openWorld(store);

    const first = recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 36_400 }),
    })!;
    expect(first.budget.warned).toEqual([75, 90]);
    expect(thresholdPayloads(store)).toEqual([75, 90]);

    const second = recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 1_200 }),
    })!;
    expect(second.budget.warned).toEqual([75, 90]);
    expect(thresholdPayloads(store)).toEqual([75, 90]);

    const third = recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 800 }),
    })!;
    expect(third.budget.warned).toEqual([75, 90, 95]);
    expect(thresholdPayloads(store)).toEqual([75, 90, 95]);

    recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 40 }),
    });
    expect(thresholdPayloads(store)).toEqual([75, 90, 95]);
  });

  test("returns undefined when execution has no usage", () => {
    const world = openWorld(openMemoryStore());

    expect(
      recordSpend(world, config(), {
        reason: "opex:drift",
        execution: { model: "claude-opus-5" },
      }),
    ).toBeUndefined();
  });

  test("rolls a stale budget to today and resets spend before adding", () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    world.recordBudget(
      { type: "budget", summary: "seed stale budget", at: 1 },
      budgetState({
        date: "2000-01-01",
        spent: { opex: 0.5, capex: 0.25 },
        activations: { opex: 5, capex: 2 },
        warned: [75],
      }),
    );

    const spend = recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 400 }),
    })!;

    expect(spend.budget.date).toBe(localDate());
    expect(spend.budget.spent.opex).toBeCloseTo(0.01, 10);
    expect(spend.budget.spent.capex).toBe(0);
    expect(spend.budget.activations).toEqual({ opex: 1, capex: 0 });
    expect(spend.budget.warned).toEqual([]);
  });
});

describe("daily digest", () => {
  test("summarizes today's world frames and excludes other days", () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const today = localDate();
    const twoDaysAgo = NOW - 2 * DAY_MS;

    world.record({
      type: "drift",
      subject: "process:old",
      summary: "old drift",
      at: twoDaysAgo,
    });
    world.record({
      type: "drift",
      subject: "process:api",
      summary: "api exited",
      incident: "inc-1",
      at: NOW,
    });
    world.record({
      type: "action",
      subject: "process:api",
      summary: "restart api",
      payload: { rule: "restart-on-exit" },
      incident: "inc-1",
      at: NOW,
    });
    world.record({
      type: "judgment",
      summary: "resolved",
      incident: "inc-1",
      at: NOW,
    });
    world.record({
      type: "escalation",
      summary: "needs human review",
      incident: "inc-2",
      at: NOW,
    });
    recordSpend(world, config(), {
      reason: "opex:drift",
      execution: execution({ outputTokens: 1_000 }),
      incident: "inc-1",
    });

    const digest = computeDigest(store.read(0), today);

    expect(digest.frames).toBe(5);
    expect(digest.drifts).toBe(1);
    expect(digest.incidents).toBe(2);
    expect(digest.ruleFirings).toEqual({ "restart-on-exit": 1 });
    expect(digest.judgments).toBe(1);
    expect(digest.escalations).toEqual(["needs human review"]);
    expect(digest.spend.opex).toBeCloseTo(0.025, 10);
    expect(digest.spend.capex).toBe(0);
    expect(digest.spend.activations).toBe(1);
    expect(renderDigest(digest)).toContain(today);
    expect(renderDigest(digest)).toContain("restart-on-exit");
  });
});

describe("rolloverBudget", () => {
  test("seeds today's budget on a fresh world", () => {
    const store = openMemoryStore();
    const world = openWorld(store);

    rolloverBudget(world, store, config());

    const frames = store.read(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("budget");
    expect(world.budget().date).toBe(localDate());
  });

  test("records yesterday's digest and preserves lastCapexDate on rollover", () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const previousAt = NOW - DAY_MS;
    const previousDate = localDate(previousAt);

    world.record({
      type: "drift",
      summary: "yesterday drift",
      at: previousAt,
    });
    world.recordBudget(
      { type: "budget", summary: "seed previous budget", at: previousAt },
      budgetState({ date: previousDate, lastCapexDate: "1999-12-31" }),
    );

    withoutConsoleLog(() => rolloverBudget(world, store, config()));

    const frames = store.read(0);
    const digest = frames.find((frame) => frame.type === "digest");
    expect(digest).toBeDefined();
    if (!digest) throw new Error("expected digest frame");
    expect(digest.summary).toContain(previousDate);
    expect(endoPayloadOf(digest)?.date).toBe(previousDate);
    expect(frames.at(-1)?.type).toBe("budget");
    expect(world.budget().date).toBe(localDate());
    expect(world.budget().lastCapexDate).toBe("1999-12-31");
  });
});
