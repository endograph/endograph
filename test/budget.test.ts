import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeContext } from "../src/agent/runtime.ts";
import { budget, budgetStateSchema, computeDigest } from "../src/batteries/budget.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";

/** A runtime context with only what the budget battery touches. */
async function ctxFor(battery: ReturnType<typeof budget>, opts: { model?: string } = {}) {
  const store = openMemoryStore();
  const world = await openWorld(store, { states: battery.states });
  const sessions: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "endo-"));
  const ctx = {
    name: "t",
    home: { root: dir } as RuntimeContext["home"],
    scripts: { cwd: dir, home: dir, src: dir },
    store,
    world,
    playbook: () => [],
    reloadPlaybook: async () => {},
    record: (input, entries) => world.record({ at: Date.now(), ...input }, entries),
    session: async (name) => (sessions.push(name), { trigger: { kind: "session", session: name }, summary: "ok", completion: "done" }),
    requestCompaction: () => {},
    executorModel: opts.model ?? "claude-sonnet-5",
  } satisfies RuntimeContext;
  battery.bind?.(ctx);
  return { ctx, store, world, sessions };
}

test("meters spend into envelopes, warns at thresholds, and schedules capex by workload", async () => {
  const b = budget({ daily_usd: 1, capex_every: 2 });
  const { store, world, sessions } = await ctxFor(b);
  const usage = { inputTokens: 100_000, outputTokens: 10_000 }; // sonnet: $0.30 + $0.15 = $0.45
  const byDrift = { kind: "drift", drift: "request.received", incident: "inc-1" } as const;
  await b.hooks!.afterActivation!({ trigger: byDrift, summary: "s", completion: "done", execution: { latencyMs: 1, model: "claude-sonnet-5", usage } });
  let state = budgetStateSchema.parse(world.state("budget", {}));
  expect(state.spent.opex).toBeCloseTo(0.45, 5);
  expect(state.opexSinceCapex).toBe(1);
  expect(sessions).toEqual([]);

  await b.hooks!.afterActivation!({ trigger: byDrift, summary: "s", completion: "done", execution: { latencyMs: 1, model: "claude-sonnet-5", usage } });
  await Bun.sleep(10);
  state = budgetStateSchema.parse(world.state("budget", {}));
  expect(state.spent.opex).toBeCloseTo(0.9, 5);
  expect(state.warned).toEqual([75, 90]);
  expect(sessions).toEqual(["capex"]);

  // Any session is capex, whoever declared it; it resets the opex counter.
  await b.hooks!.afterActivation!({ trigger: { kind: "session", session: "learn" }, summary: "s", completion: "done", execution: { latencyMs: 1, model: "claude-sonnet-5", usage } });
  state = budgetStateSchema.parse(world.state("budget", {}));
  expect(state.spent.capex).toBeCloseTo(0.45, 5);
  expect(state.opexSinceCapex).toBe(0);

  const digest = computeDigest(store.read(0), state.date);
  expect(digest.spend.activations).toBe(3);
  expect(digest.warnings).toBe(3);
  expect(b.status!()[0]!.summary).toMatch(/\$1\.35 of \$1\.00 today \(135%; opex \$0\.90, capex \$0\.45\)/);
});

test("without usage it only counts activations, and unknown models are flagged estimates", async () => {
  const b = budget({});
  const { ctx, world } = await ctxFor(b, { model: "some-new-model" });
  const byDrift = { kind: "drift", drift: "probe.failed", incident: "inc-2" } as const;
  await b.hooks!.afterActivation!({ trigger: byDrift, summary: "s", completion: "done" });
  expect(budgetStateSchema.parse(world.state("budget", {})).activations.opex).toBe(0);
  await b.hooks!.afterActivation!({ trigger: byDrift, summary: "s", completion: "done", execution: { latencyMs: 1, model: "some-new-model", usage: { inputTokens: 1000, outputTokens: 0 } } });
  const spend = ctx.store.read(0).find((f) => f.type === "spend");
  expect(spend?.summary).toContain("(est.)");
});
