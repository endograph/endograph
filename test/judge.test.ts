import { describe, expect, test } from "bun:test";
import type { ExecutorRunRequest, ProjectorExecutor } from "@projectors/core";
import { activate, composeInstructions } from "../src/judge/activate.ts";
import { buildJudgeActions } from "../src/judge/actions.ts";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import { MockLanguageModelV3 } from "ai/test";
import { JudgeRuntime } from "../src/judge/runtime.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";

function entry(summary: string) {
  return {
    kind: "process",
    state: "green" as const,
    summary,
    data: {},
    updatedAt: 1_700_000_000_000,
  };
}

describe("activation via the machine", () => {
  test("non-inert frame schedules work; executor sees instructions, world, tools", async () => {
    const store = openMemoryStore();
    const requests: ExecutorRunRequest[] = [];
    const executor: ProjectorExecutor = {
      run: (request) => {
        requests.push(request as ExecutorRunRequest);
        return { completionReason: "done", value: "diagnosed: all fine" };
      },
      realizePrompt: (r) => ({ provider: "test", input: r.inference }),
    };
    const runtime = new JudgeRuntime();
    const world = openWorld(store, {
      instructions: composeInstructions("# Charter\n\nTend the stack."),
      tools: buildJudgeActions(runtime),
      executor,
    });
    world.record(
      {
        type: "process",
        subject: "process:api",
        summary: "api ready",
        at: 1,
      },
      { "process:api": entry("ready (pid 1)") },
    );

    const outcome = await activate(world, {
      text: "Unmatched drift: something odd",
      incident: "inc-test",
      reason: "opex:drift",
    });

    expect(outcome).toEqual({ summary: "diagnosed: all fine", reason: "done" });
    expect(requests).toHaveLength(1);
    const inference = requests[0]!.inference;
    const preamble = inference.preamble
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    expect(preamble).toContain("Charter (owner's mandate)");
    const recency = inference.recency
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    expect(recency).toContain("process:api");
    expect(recency).toContain("State `budget`");
    expect(recency).toContain("spent");
    expect(inference.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "compact",
      "escalate",
      "reply",
      "resolve",
      "run_procedure",
      "try_rule",
      "world",
      "write_playbook_entry",
    ]);
    // The activation, its work frames, and the completion are all durable.
    const types = store.read(0).map((f) => f.type);
    expect(types).toContain("activation");
    expect(types.filter((t) => t === "machine").length).toBeGreaterThan(0);
  });

  test("inert records never schedule work", async () => {
    const store = openMemoryStore();
    let ran = 0;
    const world = openWorld(store, {
      executor: {
        run: () => {
          ran++;
          return { completionReason: "done" };
        },
        realizePrompt: (r) => ({ provider: "test", input: r.inference }),
      },
    });
    world.record({ type: "drift", summary: "observed", at: 1 });
    // No activation is materialized for inert frames.
    const { reconcileWork, collectRunnableActivations } = await import(
      "@projectors/core"
    );
    reconcileWork(world.machine);
    expect(collectRunnableActivations(world.machine)).toHaveLength(0);
    expect(ran).toBe(0);
  });
});

describe("AI SDK executor tool loop", () => {
  test("tool calls run actions, results go back, terminal action ends the loop", async () => {
    const store = openMemoryStore();
    const runtime = new JudgeRuntime();
    const recorded: string[] = [];
    runtime.bind({
      verbs: new Map(),
      projectDir: process.cwd(),
      agentDir: "/tmp/nonexistent-agent",
      playbookDir: "/tmp/nonexistent-playbook",
      playbook: () => [],
      onPlaybookChanged: async () => {},
      record: (input) => recorded.push(`${input.type}:${input.subject}`),
    });

    let call = 0;
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doGenerate: async ({ prompt }) => {
        call++;
        const system = prompt.find((m) => m.role === "system");
        expect(JSON.stringify(system)).toContain("embedded agent");
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "world",
                input: JSON.stringify({ op: "set", subject: "target:stout", summary: "ok" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          } as never;
        }
        // The previous tool result must have been fed back.
        expect(JSON.stringify(prompt)).toContain("set target:stout");
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_2",
              toolName: "resolve",
              input: JSON.stringify({ diagnosis: "fine", action_taken: "set world" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 20, noCache: 10, cacheRead: 10, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        } as never;
      },
    });
    const world = openWorld(store, {
      instructions: composeInstructions(null),
      tools: buildJudgeActions(runtime),
      executor: new AiSdkExecutor({ model, maxSteps: 5, turnDeadlineMs: 60_000 }),
    });

    const outcome = await activate(world, { text: "a request", reason: "opex:drift" });

    expect(outcome.reason).toBe("terminal-action");
    expect(outcome.summary).toBe("resolved: fine — set world");
    expect(outcome.execution?.model).toBe("mock-model");
    expect(outcome.execution?.usage?.inputTokens).toBeGreaterThan(0);
    expect(recorded).toEqual(["world:target:stout"]);
    expect(call).toBe(2);
    // The action calls landed in the frame log with attribution.
    const payloads = store.read(0).map((f) => JSON.stringify(f.payload));
    expect(payloads.some((p) => p.includes('"name":"resolve"'))).toBe(true);
  });
});
