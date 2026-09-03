import { expect, test } from "bun:test";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";
import type { Migrator } from "../src/world/migrate.ts";
import { createState, recencyRegion } from "@projectors/core";
import { z } from "zod";

const entry = { kind: "target", state: "green" as const, summary: "up", data: {}, updatedAt: 1 };

test("records frames, folds world entries, and rehydrates from the store", async () => {
  const store = openMemoryStore();
  const world = await openWorld(store);
  world.record({ type: "world", subject: "target:stout", summary: "set", at: 1 }, { set: { "target:stout": entry } });
  world.record({ type: "note", summary: "hello", at: 2 });
  expect((world.world()["target:stout"] as { summary: string }).summary).toBe("up");
  expect(store.read(0).map((f) => f.type)).toEqual(["world", "note"]);
  world.record({ type: "world", subject: "target:stout", summary: "clear", at: 3 }, { clear: ["target:stout"] });
  expect(world.world()).toEqual({});

  const again = await openWorld(store);
  expect(again.historyLength()).toBe(3);
  expect(again.world()).toEqual({});
});

test("battery states are projected and replaced through recordState", async () => {
  const store = openMemoryStore();
  const counter = createState({ key: "counter", schema: z.object({ n: z.number() }), init: { n: 0 }, projection: { slot: recencyRegion } });
  const world = await openWorld(store, { states: [counter] });
  expect(world.state("counter", { n: -1 })).toEqual({ n: 0 });
  world.recordState({ type: "tick", summary: "n=1", at: 1 }, "counter", { n: 1 });
  expect(world.state("counter", { n: -1 })).toEqual({ n: 1 });
  expect((await openWorld(store, { states: [counter] })).state("counter", { n: -1 })).toEqual({ n: 1 });
});

test("compaction bounds the machine's view but not the store", async () => {
  const store = openMemoryStore();
  const world = await openWorld(store);
  for (let i = 0; i < 5; i++) world.record({ type: "note", summary: `n${i}`, at: i });
  world.record({ type: "world", subject: "a", summary: "a", at: 9 }, { set: { a: entry } });
  world.compact("everything so far");
  expect(world.historyLength()).toBe(1);
  expect(world.world().a).toBeDefined();
  expect(store.lastSeq()).toBe(7);
  world.record({ type: "note", summary: "after", at: 10 });
  const reopened = await openWorld(store);
  expect(reopened.historyLength()).toBe(2);
  expect(reopened.world().a).toBeDefined();
});

test("replay is not truncated at the store's default read batch", async () => {
  const store = openMemoryStore();
  const world = await openWorld(store);
  for (let i = 0; i < 1500; i++) world.record({ type: "note", summary: `n${i}`, at: i });
  world.record({ type: "world", subject: "last", summary: "last", at: 1501 }, { set: { last: entry } });
  const reopened = await openWorld(store);
  expect(reopened.historyLength()).toBe(1501);
  expect(reopened.world().last).toBeDefined();
});

test("drain folds queued frames without scheduling work", async () => {
  const store = openMemoryStore();
  const world = await openWorld(store);
  for (let i = 0; i < 20; i++) world.record({ type: "note", summary: `n${i}`, at: i });
  const queued = (world.machine as unknown as { pendingFrames: unknown[] }).pendingFrames.length;
  expect(queued).toBe(20);
  expect(await world.drain()).toBe(20);
  expect((world.machine as unknown as { pendingFrames: unknown[] }).pendingFrames.length).toBe(0);
  const reopened = await openWorld(store);
  expect(await reopened.drain()).toBe(20);
});

test("a world write the schema rejects never lands", async () => {
  const store = openMemoryStore();
  const world = await openWorld(store);
  expect(() => world.record({ type: "world", subject: "x", summary: "bad", at: 1 }, { set: { x: { not: "an entry" } } })).toThrow();
  expect(world.world()).toEqual({});
});

test("the self component evolves: transition reshapes it, spawn and cede manage children, and it survives a rebuild", async () => {
  const { defineAgent } = await import("../src/agent/define.ts");
  const { serializeNode, createNode: mk } = await import("@projectors/core");
  const { selfNode, childNode, evolvable } = await import("../src/judge/evolve.ts");
  const store = openMemoryStore();
  const def = defineAgent({ name: "evo", children: [evolvable()] });
  const open = () => openWorld(store, { tools: def.tools, states: def.states, children: def.children, childActions: def.childActions, migrate: null });
  const world = await open();
  expect(world.self()?.node).toBe("endo-self");
  const selfId = world.self()!.id;

  // The transition tool builds the node; the machine applies the instance message the tool would enqueue.
  const reshaped = selfNode({ notes: "stout sleeps at night", tools: ["world"] }, (name) => world.charter.actions[name]?.state);
  world.machine.enqueueFrame({ messages: [{ type: "instance", kind: "transition", instanceId: selfId, node: serializeNode(reshaped, world.charter) }] });
  const self = world.self()!;
  expect(typeof self.node === "object" && self.node.key).toBe("endo-self");
  const parts = (self.node as { parts?: unknown[] }).parts ?? [];
  expect(JSON.stringify(parts)).toContain("stout sleeps at night");
  expect(JSON.stringify(parts)).toContain('"world"');

  world.machine.enqueueFrame({ messages: [{ type: "instance", kind: "spawn", parentInstanceId: selfId, children: [{ node: serializeNode(childNode({ key: "helper-watch", kind: "helper", instructions: "watch stout", tools: [] }), world.charter) }] }] });
  expect(world.self()?.children?.map((c) => (typeof c.node === "object" ? c.node.key : c.node))).toEqual(["helper-watch"]);
  const helperId = world.self()!.children![0]!.id;
  world.machine.enqueueFrame({ messages: [{ type: "instance", kind: "remove", instanceId: helperId, reason: "cede" }] });
  expect(world.self()?.children ?? []).toEqual([]);

  // A rebuild re-hydrates the de novo self from the snapshot: notes and chosen tools survive.
  await world.reconfigure({ instructions: "new mandate" });
  expect(JSON.stringify(world.self())).toContain("stout sleeps at night");
  const reopened = await open();
  expect(JSON.stringify(reopened.self())).toContain("stout sleeps at night");
  void mk;
});

test("a self that references a tool the charter lost is migrated on rebuild, and snapshotted", async () => {
  const { defineAgent } = await import("../src/agent/define.ts");
  const { serializeNode, createAction } = await import("@projectors/core");
  const { selfNode, evolvable } = await import("../src/judge/evolve.ts");
  const { MigrationFailed } = await import("../src/world/migrate.ts");
  const store = openMemoryStore();
  const def = defineAgent({ name: "mig", children: [evolvable()] });
  const extra = createAction({ state: null, name: "deploy", inputSchema: z.object({}), run: () => "ok" });
  const calls: string[] = [];
  const stubMigrator: Migrator = async (input) => {
    calls.push(input.error);
    // Drop the dangling tool ref from the self's parts.
    const self = input.serialized.children?.find((c) => (typeof c.node === "string" ? c.node : c.node.key) === "endo-self");
    const node = self?.node as { parts?: { kind: string; ref?: unknown }[] } | undefined;
    if (node?.parts) node.parts = node.parts.filter((p) => !(p.kind === "action" && p.ref === "deploy"));
    return input.serialized;
  };
  const world = await openWorld(store, { tools: [...def.tools, extra], states: def.states, children: def.children, childActions: def.childActions, migrate: stubMigrator });
  world.machine.enqueueFrame({ messages: [{ type: "instance", kind: "transition", instanceId: world.self()!.id, node: serializeNode(selfNode({ tools: ["deploy"] }), world.charter) }] });
  expect(JSON.stringify(world.self())).toContain('"deploy"');

  // The owner's charter loses `deploy`: the persisted self no longer hydrates → migrated.
  await world.reconfigure({ tools: def.tools });
  expect(calls.length).toBe(1);
  expect(calls[0]).toMatch(/deploy/);
  expect(JSON.stringify(world.self())).not.toContain('"deploy"');
  expect(store.read(0).some((f) => f.type === "migration" && /snapshotted/.test(f.summary))).toBe(true);

  // Without a migrator the failure is loud.
  const strict = openMemoryStore();
  const w2 = await openWorld(strict, { tools: [...def.tools, extra], states: def.states, children: def.children, childActions: def.childActions, migrate: null });
  w2.machine.enqueueFrame({ messages: [{ type: "instance", kind: "transition", instanceId: w2.self()!.id, node: serializeNode(selfNode({ tools: ["deploy"] }), w2.charter) }] });
  await expect(w2.reconfigure({ tools: def.tools })).rejects.toBeInstanceOf(MigrationFailed);
});

test("a declared child absent from a persisted instance is attached on open; an agent without evolvable() has no self", async () => {
  const { defineAgent } = await import("../src/agent/define.ts");
  const { evolvable } = await import("../src/judge/evolve.ts");
  const store = openMemoryStore();
  const plain = defineAgent({ name: "attach" });
  const before = await openWorld(store, { tools: plain.tools, states: plain.states, migrate: null });
  expect(before.self()).toBeUndefined();
  expect(plain.evolvable).toBe(false);
  before.record({ type: "note", summary: "old times", at: 1 });
  before.snapshot();
  const def = defineAgent({ name: "attach", children: [evolvable()] });
  expect(def.evolvable).toBe(true);
  const evolved = await openWorld(store, { tools: def.tools, states: def.states, children: def.children, childActions: def.childActions, migrate: null });
  expect(evolved.self()?.node).toBe("endo-self");
  expect(store.read(0).some((f) => f.type === "evolve" && /attached/.test(f.summary))).toBe(true);
  // Idempotent: reopening does not attach twice.
  const again = await openWorld(store, { tools: def.tools, states: def.states, children: def.children, childActions: def.childActions, migrate: null });
  expect(store.read(0).filter((f) => f.type === "evolve" && /attached/.test(f.summary)).length).toBe(1);
  expect(again.self()?.id).toBe("endo-self");
});
