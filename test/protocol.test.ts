import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, readReply, waitForReply, writeMessage, writeReply } from "../src/protocol/wire.ts";

test("messages land atomically in the inbox; replies round-trip through the outbox by id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-"));
  const inbox = join(dir, "inbox");
  const outbox = join(dir, "outbox");
  writeMessage(inbox, { v: PROTOCOL_VERSION, kind: "request", id: "r1", text: "hi", at: 5 });
  expect(readdirSync(inbox)).toEqual(["5-r1.json"]);
  expect(readReply(outbox, "r1")).toBeNull();
  expect(await waitForReply(outbox, "r1", { timeoutMs: 30, pollMs: 10 })).toBeNull();
  const pending = waitForReply(outbox, "r1", { timeoutMs: 2000, pollMs: 10 });
  writeReply(outbox, { v: PROTOCOL_VERSION, id: "r1", ok: true, state: "completed", text: "done", at: 6 });
  expect((await pending)?.text).toBe("done");
  expect(readdirSync(outbox)).toEqual(["r1.json"]);
});
