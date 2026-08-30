import { beforeEach, describe, expect, test } from "bun:test";
import { openMemoryStore } from "../src/store/memory.ts";
import type { FrameStore } from "../src/store/types.ts";
import type { WorldEntry } from "../src/world/model.ts";
import { openWorld } from "../src/world/world.ts";

let store: FrameStore;

beforeEach(() => {
  store = openMemoryStore();
});

function entry(overrides: Partial<WorldEntry> = {}): WorldEntry {
  return {
    kind: "process",
    state: "green",
    summary: "api ready",
    data: { pid: 123, cmd: "bun run api" },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("openWorld", () => {
  test("record() appends a frame with endograph envelope columns", () => {
    const world = openWorld(store);

    world.record({
      type: "drift",
      subject: "process:api",
      summary: "api exited",
      incident: "incident-1",
      at: 1_700_000_000_001,
      payload: { exitCode: 1 },
    });

    const frames = store.read(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      seq: 1,
      type: "drift",
      subject: "process:api",
      summary: "api exited",
      incident: "incident-1",
      at: 1_700_000_000_001,
    });
    expect(frames[0]?.payload).toMatchObject({
      inert: true,
      metadata: {
        endo: {
          type: "drift",
          subject: "process:api",
          summary: "api exited",
          incident: "incident-1",
          at: 1_700_000_000_001,
          payload: { exitCode: 1 },
        },
      },
    });
  });

  test("record with entries updates world(), and null entries delete", () => {
    const world = openWorld(store);

    world.record(
      {
        type: "process",
        subject: "process:api",
        summary: "api ready",
        at: 1_700_000_000_001,
      },
      { "process:api": entry() },
    );
    expect(world.world()).toEqual({ "process:api": entry() });

    world.record(
      {
        type: "process",
        subject: "process:api",
        summary: "api removed",
        at: 1_700_000_000_002,
      },
      { "process:api": null },
    );
    expect(world.world()).toEqual({});
  });

  test("rehydrates world state from the memory store log", () => {
    const world = openWorld(store);
    const api = entry({ summary: "api ready", updatedAt: 1_700_000_000_001 });
    const worker = entry({
      summary: "worker starting",
      state: "yellow",
      data: { pid: 456 },
      updatedAt: 1_700_000_000_002,
    });
    const apiUpdated = entry({
      summary: "api degraded",
      state: "yellow",
      data: { pid: 123, reason: "probe failed" },
      updatedAt: 1_700_000_000_003,
    });

    world.record(
      { type: "process", subject: "process:api", summary: "api ready", at: 1 },
      { "process:api": api },
    );
    world.record(
      {
        type: "process",
        subject: "process:worker",
        summary: "worker starting",
        at: 2,
      },
      { "process:worker": worker },
    );
    world.record(
      { type: "process", subject: "process:api", summary: "api degraded", at: 3 },
      { "process:api": apiUpdated },
    );

    const reopened = openWorld(store);

    expect(reopened.world()).toEqual({
      "process:api": apiUpdated,
      "process:worker": worker,
    });
    expect(store.lastSeq()).toBe(3);
  });

  test("snapshot then reopen reproduces world state", () => {
    const world = openWorld(store);
    const api = entry({ summary: "api ready", updatedAt: 1_700_000_000_001 });
    const worker = entry({
      summary: "worker ready",
      data: { pid: 456 },
      updatedAt: 1_700_000_000_002,
    });

    world.record(
      { type: "process", subject: "process:api", summary: "api ready", at: 1 },
      { "process:api": api },
    );
    world.snapshot();
    world.record(
      {
        type: "process",
        subject: "process:worker",
        summary: "worker ready",
        at: 2,
      },
      { "process:worker": worker },
    );

    const reopened = openWorld(store);

    expect(reopened.world()).toEqual({
      "process:api": api,
      "process:worker": worker,
    });
    expect(store.readSnapshot()?.asOfSeq).toBe(1);
    expect(store.lastSeq()).toBe(2);
  });

  test("compact() starts the machine's history at the summary; the store keeps everything", () => {
    const world = openWorld(store);
    world.record(
      { type: "process", subject: "process:api", summary: "api ready", at: 1 },
      { "process:api": entry() },
    );
    world.record({ type: "note", summary: "old chatter 1", at: 2 });
    world.record({ type: "note", summary: "old chatter 2", at: 3 });
    expect(world.historyLength()).toBe(3);

    world.compact("api is ready; nothing else matters");
    expect(world.historyLength()).toBe(1);
    expect(world.world()).toEqual({ "process:api": entry() });

    world.record({ type: "note", summary: "after compaction", at: 5 });
    expect(world.historyLength()).toBe(2);
    expect(store.read(0).map((f) => f.type)).toEqual(["process", "note", "note", "compaction", "note"]);

    // Reopening rebuilds from the compaction frame, state intact.
    const reopened = openWorld(store);
    expect(reopened.historyLength()).toBe(2);
    expect(reopened.world()).toEqual({ "process:api": entry() });
    expect(store.read(0)[3]!.summary).toBe("compacted: api is ready; nothing else matters");

    // A later snapshot never hides the compaction frame from the next open.
    reopened.record({ type: "note", summary: "more", at: 6 });
    reopened.snapshot();
    expect(openWorld(store).historyLength()).toBe(3);
  });

  test("budget() applies schema defaults to state from before a field existed", () => {
    const world = openWorld(store);
    const legacy = { ...world.budget() } as Record<string, unknown>;
    delete legacy.opexSinceCapex;
    world.recordBudget({ type: "budget", summary: "legacy", at: 1 }, legacy as never);
    expect(world.budget().opexSinceCapex).toBe(0);
  });

  test("reconfigure() swaps the mandate and keeps history and state", () => {
    const world = openWorld(store, { instructions: "old mandate" });
    world.record(
      { type: "process", subject: "process:api", summary: "api ready", at: 1 },
      { "process:api": entry() },
    );
    world.record({ type: "note", summary: "still here", at: 2 });

    const before = world.charter;
    world.reconfigure({ instructions: "new mandate" });

    expect(world.charter).not.toBe(before);
    expect(JSON.stringify(world.charter)).toContain("new mandate");
    expect(JSON.stringify(world.charter)).not.toContain("old mandate");
    expect(world.historyLength()).toBe(2);
    expect(world.world()).toEqual({ "process:api": entry() });
    expect(store.lastSeq()).toBe(2);
  });

  test("after reopen, new records do not duplicate old frames in the store", () => {
    const world = openWorld(store);
    world.record(
      { type: "process", subject: "process:api", summary: "api ready", at: 1 },
      { "process:api": entry() },
    );
    world.record(
      { type: "note", subject: "process:api", summary: "checked api", at: 2 },
    );
    expect(store.lastSeq()).toBe(2);

    const reopened = openWorld(store);
    expect(store.lastSeq()).toBe(2);

    reopened.record({
      type: "note",
      subject: "process:api",
      summary: "checked after reopen",
      at: 3,
    });

    expect(store.lastSeq()).toBe(3);
    expect(store.read(0).map((frame) => frame.summary)).toEqual([
      "api ready",
      "checked api",
      "checked after reopen",
    ]);
  });
});
