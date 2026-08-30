import { describe, expect, test } from "bun:test";
import { Loop } from "../src/core/loop.ts";
import type { Drift, VerbResult } from "../src/core/types.ts";
import type { PlaybookRule } from "../src/playbook/types.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";

function rule(overrides: Partial<PlaybookRule> = {}): PlaybookRule {
  return {
    kind: "rule",
    name: "echo",
    file: "echo.md",
    on: "request.received",
    provenance: "test",
    cooldownSeconds: 0,
    onFailure: "judge",
    body: "",
    script: "echo handled $ENDO_DRIFT_INCIDENT",
    ...overrides,
  };
}

function drift(overrides: Partial<Drift> = {}): Drift {
  return {
    kind: "request.received",
    subject: "request:inc-a",
    summary: "deploy please",
    observedAt: 1,
    incident: "inc-a",
    ...overrides,
  };
}

describe("loop", () => {
  test("a matching rule runs and settles the drift with its outcome, under the drift's incident", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const settled: VerbResult[] = [];
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [rule()],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));

    // A successful script's last stdout line is what the requester reads.
    expect(settled).toEqual([
      { ok: true, summary: "handled inc-a", detail: "handled inc-a" },
    ]);
    expect(store.read(0).map((f) => [f.type, f.incident])).toEqual([
      ["drift", "inc-a"],
      ["action", "inc-a"],
      ["outcome", "inc-a"],
    ]);
  });

  test("unmatched drift goes to judgment and settles with its verdict", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const settled: VerbResult[] = [];
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
      onUnmatched: async (d, incident) => {
        expect(incident).toBe("inc-a");
        return { ok: false, summary: `judged ${d.subject}` };
      },
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));

    expect(settled).toEqual([{ ok: false, summary: "judged request:inc-a" }]);
  });

  test("a failing rule hands the drift to judgment with its output; on_failure=settle does not", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const judged: string[] = [];
    const settled: VerbResult[] = [];
    const failing = rule({ name: "strict", script: "echo nope; exit 3" });
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [failing],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
      onUnmatched: async (_d, _i, context) => {
        judged.push(`${context?.ruleFailure?.rule}:${context?.ruleFailure?.result.detail}`);
        return { ok: true, summary: "model took over" };
      },
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));
    expect(judged).toEqual(["strict:nope"]);
    expect(settled).toEqual([{ ok: true, summary: "model took over" }]);

    failing.onFailure = "settle";
    await loop.handle(drift({ subject: "request:inc-b", incident: "inc-b", settle: (r) => settled.push(r) }));
    expect(judged).toHaveLength(1);
    expect(settled[1]).toMatchObject({ ok: false, summary: "script exited 3" });
  });

  test("exit 64 is a refusal: settled not-ok with the script's last line, never judged", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    let judged = 0;
    const settled: VerbResult[] = [];
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [rule({ name: "policy", script: "echo commit first >&2; exit 64" })],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
      onUnmatched: async () => {
        judged++;
        return { ok: true, summary: "should not happen" };
      },
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));

    expect(judged).toBe(0);
    expect(settled).toEqual([
      { ok: false, summary: "commit first", detail: "commit first", refused: true },
    ]);
    expect(store.read(0).map((f) => f.summary).at(-1)).toBe("rule policy: refused — commit first");
  });

  test("exit 75 leaves the drift unsettled: a background job owns the answer", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    let judged = 0;
    const settled: VerbResult[] = [];
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [rule({ name: "bg", script: "echo started build; exit 75" })],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
      onUnmatched: async () => {
        judged++;
        return { ok: true, summary: "should not happen" };
      },
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));

    expect(judged).toBe(0);
    expect(settled).toEqual([]);
    expect(store.read(0).map((f) => f.summary).at(-1)).toBe("rule bg: in progress — started build");
  });

  test("without a judgment layer the drift is escalated and settled not-ok", async () => {
    const store = openMemoryStore();
    const world = openWorld(store);
    const settled: VerbResult[] = [];
    const loop = new Loop({
      world,
      sensors: [],
      playbook: () => [],
      projectDir: process.cwd(),
      agentDir: process.cwd(),
    });

    await loop.handle(drift({ settle: (r) => settled.push(r) }));

    expect(settled[0]!.ok).toBe(false);
    expect(store.read(0).map((f) => f.type)).toEqual(["drift", "escalation"]);
  });
});
