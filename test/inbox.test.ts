import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, findReply, waitForReply, writeMessage, writeRequest } from "../src/inbox/inbox.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";

let dir!: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "endograph-inbox-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const store = openMemoryStore();
  const world = openWorld(store);
  const inbox = new Inbox({
    dir,
    record: (input, entries) => world.record(input, entries),
  });
  return { store, world, inbox };
}

describe("inbox", () => {
  test("a poll drains every request into one drift and records each request", async () => {
    const { store, inbox } = harness();
    writeRequest(dir, { incident: "inc-a", from: "fox:/w1", ref: "abc", text: "deploy", at: 1 });
    writeRequest(dir, { incident: "inc-b", from: "fox:/w2", text: "deploy too", at: 2 });

    const drifts = await inbox.poll();

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      kind: "request.received",
      subject: "request:inc-a",
      incident: "inc-a",
      observedAt: 2,
    });
    expect((drifts[0]!.data!.requests as unknown[]).length).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(store.read(0).map((f) => [f.type, f.incident])).toEqual([
      ["request", "inc-a"],
      ["request", "inc-b"],
    ]);
    expect(await inbox.poll()).toEqual([]);
  });

  test("explicit reply answers once; settle answers the rest", async () => {
    const { store, inbox } = harness();
    writeRequest(dir, { incident: "inc-a", from: "x", text: "one", at: 1 });
    writeRequest(dir, { incident: "inc-b", from: "y", text: "two", at: 2 });
    const [drift] = await inbox.poll();

    expect(inbox.reply("inc-a", true, "deployed abc")).toBe(true);
    expect(inbox.reply("inc-a", true, "again")).toBe(false);
    drift!.settle!({ ok: false, summary: "superseded", detail: "by inc-a" });
    // A detail that already ends with the summary is not repeated.
    writeRequest(dir, { incident: "inc-c", from: "z", text: "three", at: 3 });
    const [second] = await inbox.poll();
    second!.settle!({ ok: true, summary: "deployed x", detail: "building…\ndeployed x" });
    expect(findReply(store, "inc-c")).toMatchObject({ ok: true, text: "building…\ndeployed x" });

    expect(findReply(store, "inc-a")).toMatchObject({ ok: true, text: "deployed abc" });
    expect(findReply(store, "inc-b")).toMatchObject({ ok: false, text: "superseded\nby inc-a" });
    expect(inbox.pendingRequests()).toEqual([]);
    expect(store.read(0).filter((f) => f.type === "reply")).toHaveLength(3);
  });

  test("a reply message from a peer answers a pending request; unknown incidents are noted", async () => {
    const { store, inbox } = harness();
    writeRequest(dir, { incident: "inc-a", from: "x", text: "deploy", at: 1 });
    await inbox.poll();
    writeMessage(dir, { kind: "reply", incident: "inc-a", ok: true, text: "deployed abc", from: "job", at: 2 });
    writeMessage(dir, { kind: "reply", incident: "inc-zzz", ok: true, text: "?", from: "job", at: 3 });

    expect(await inbox.poll()).toEqual([]);

    expect(findReply(store, "inc-a")).toMatchObject({ ok: true, text: "deployed abc" });
    expect(inbox.pendingRequests()).toEqual([]);
    expect(store.read(0).at(-1)).toMatchObject({ type: "note", incident: "inc-zzz" });
  });

  test("a world message sets and clears world entries", async () => {
    const { world, inbox } = harness();
    writeMessage(dir, {
      kind: "world", op: "set", subject: "target:stout", state: "yellow",
      summary: "building since 09:41", data: { started: 1 }, from: "job", at: 1,
    });
    expect(await inbox.poll()).toEqual([]);
    expect(world.world()["target:stout"]).toMatchObject({
      kind: "target", state: "yellow", summary: "building since 09:41", data: { started: 1 },
    });

    writeMessage(dir, { kind: "world", op: "clear", subject: "target:stout", from: "job", at: 2 });
    await inbox.poll();
    expect(world.world()).toEqual({});
  });

  test("malformed files are discarded with an error frame", async () => {
    const { store, inbox } = harness();
    writeFileSync(join(dir, "1-bad.json"), "{not json");
    expect(await inbox.poll()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(store.read(0)[0]).toMatchObject({ type: "error", subject: "inbox" });
  });

  test("waitForReply resolves when the reply lands and null on timeout", async () => {
    const { store, inbox } = harness();
    writeRequest(dir, { incident: "inc-a", from: "x", text: "one", at: 1 });
    await inbox.poll();

    const waiting = waitForReply(store, "inc-a", { timeoutMs: 2000, pollMs: 10 });
    setTimeout(() => inbox.reply("inc-a", true, "done"), 30);
    expect(await waiting).toMatchObject({ incident: "inc-a", ok: true, text: "done" });

    expect(await waitForReply(store, "inc-zzz", { timeoutMs: 30, pollMs: 10 })).toBeNull();
  });
});
