import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../src/inbox/inbox.ts";
import { readReply, waitForReply, writeMessage, PROTOCOL_VERSION, type CallMessage } from "../src/inbox/protocol.ts";
import type { FrameInput } from "../src/store/types.ts";

function setup(onCall?: (c: CallMessage) => Promise<{ ok: boolean; summary: string; pending?: boolean; refused?: boolean }>) {
  const dir = mkdtempSync(join(tmpdir(), "endo-"));
  const frames: Partial<FrameInput>[] = [];
  const inbox = new Inbox({
    inboxDir: join(dir, "inbox"),
    outboxDir: join(dir, "outbox"),
    record: (f) => frames.push(f),
    onCall: onCall ?? (async () => ({ ok: true, summary: "called" })),
    onSession: async (name, ask) => ({ ok: true, summary: `${name}: ${ask ?? "no ask"}` }),
  });
  return { dir, frames, inbox, inboxDir: join(dir, "inbox"), outboxDir: join(dir, "outbox") };
}

test("a batch of requests is one drift; settlement answers the unanswered", async () => {
  const { inbox, inboxDir, outboxDir, frames } = setup();
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-1", from: "local:t", text: "deploy", at: 1 });
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-2", from: "local:t", text: "status?", at: 2 });
  const drifts = await inbox.poll();
  expect(drifts.length).toBe(1);
  expect(drifts[0]!.summary).toMatch(/2 requests pending/);
  expect(inbox.reply("inc-1", true, "done")).toBe(true);
  expect(inbox.reply("inc-1", true, "again")).toBe(false);
  drifts[0]!.settle!({ ok: false, summary: "superseded" });
  expect(readReply(outboxDir, "inc-1")).toMatchObject({ ok: true, state: "completed", text: "done" });
  expect(readReply(outboxDir, "inc-2")).toMatchObject({ ok: false, state: "failed", text: "superseded" });
  expect(frames.filter((f) => f.type === "reply").length).toBe(2);
  expect(await inbox.poll()).toEqual([]);
});

test("a call runs the procedure and replies without a drift; refusal is rejected", async () => {
  const calls: CallMessage[] = [];
  const { inbox, inboxDir, outboxDir } = setup(async (c) => {
    calls.push(c);
    return c.procedure === "nope" ? { ok: false, refused: true, summary: "no such" } : { ok: true, summary: `ran ${c.args.X}` };
  });
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "call", incident: "inc-c1", from: "local:t", procedure: "deploy", args: { X: "1" }, at: 1 });
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "call", incident: "inc-c2", from: "local:t", procedure: "nope", args: {}, at: 2 });
  expect(await inbox.poll()).toEqual([]);
  expect((await waitForReply(outboxDir, "inc-c1", { timeoutMs: 2000, pollMs: 20 }))?.text).toBe("ran 1");
  expect((await waitForReply(outboxDir, "inc-c2", { timeoutMs: 2000, pollMs: 20 }))?.state).toBe("rejected");
  expect(calls.map((c) => c.procedure)).toEqual(["deploy", "nope"]);
});

test("a request naming a session starts it and is answered with its outcome, not judged", async () => {
  const { inbox, inboxDir, outboxDir } = setup();
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-s", from: "local:t", text: "look at deploys", session: "capex", at: 1 });
  expect(await inbox.poll()).toEqual([]);
  expect((await waitForReply(outboxDir, "inc-s", { timeoutMs: 2000, pollMs: 20 }))?.text).toBe("capex: look at deploys");
});

test("reply and world messages act on the agent's behalf", async () => {
  const { inbox, inboxDir, outboxDir, frames } = setup();
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-1", from: "local:t", text: "long job", at: 1 });
  await inbox.poll();
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "reply", incident: "inc-1", ok: true, text: "job done", from: "local:job", at: 2 });
  writeMessage(inboxDir, { v: PROTOCOL_VERSION, kind: "world", incident: "", set: { "target:stout": { kind: "target", state: "green", summary: "up", data: {}, updatedAt: 3 } }, from: "local:job", at: 3 });
  await inbox.poll();
  expect(readReply(outboxDir, "inc-1")?.text).toBe("job done");
  expect(frames.find((f) => f.type === "world")?.subject).toBe("target:stout");
});
