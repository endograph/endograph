import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextUpdate } from "../src/context.ts";
import type { Projection } from "../src/protocol.ts";
import { checkpoint, SessionFiles, type SessionRecord } from "../src/sessions.ts";

interface Session extends SessionRecord { threadId: string }
const projection: Projection = { preamble: '["Tend this system."]', recency: '["State: deployed"]', tools: [], history: ['{"text":"one"}', '{"text":"two"}'] };

test("a session resumes only when checkpointed, durably committed, and saved under the same model", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "endo-sessions-"));
  const committed = new Set<string>();
  const files = (model = "gpt") => new SessionFiles<Session>({ stateDir, model, isActivationCommitted: (id) => committed.has(id) }, "threadId");
  try {
    const session: Session = { version: 1, threadId: "thread", model: "gpt", pending: "first" };
    expect(files().read("generator")).toBeUndefined();
    checkpoint(session, { activationId: "first", projection, observed: [] });
    files().save("generator", session);
    expect(files().read("generator")).toBeUndefined();
    committed.add("first");
    expect(files().read("generator")).toEqual(session);
    expect(files().read("other")).toBeUndefined();
    expect(files("claude").read("generator")).toBeUndefined();
    // A native turn may have run past the committed activation.
    files().save("generator", { ...session, pending: "second" });
    expect(files().read("generator")).toBeUndefined();
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("checkpoint clears pending and records what was sent; after a compaction it forgets only standing context", () => {
  const observed = '{"text":"three"}';
  const session: Session = { version: 1, threadId: "thread", pending: "a" };
  checkpoint(session, { activationId: "a", projection, observed: [observed] });
  expect(session).toMatchObject({ activationId: "a" });
  expect(session.pending).toBeUndefined();
  expect(contextUpdate({ ...projection, history: [...projection.history, observed] }, session.cursor)).toBe("{}");
  Object.assign(session, { pending: "b", compacted: true });
  checkpoint(session, { activationId: "b", projection, observed: [] });
  expect(session).toMatchObject({ activationId: "b" });
  expect(session.pending).toBeUndefined();
  expect(session.compacted).toBeUndefined();
  expect(JSON.parse(contextUpdate(projection, session.cursor))).toEqual({ preamble: ["Tend this system."], recency: ["State: deployed"], actions: [] });
});
