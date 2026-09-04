import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "@projectors/core";
import { bash } from "../src/batteries/bash.ts";
import { coreActions } from "../src/grant/core.ts";
import { defineAgent, isGrant } from "../src/grant/define.ts";
import type { ExecutorSpec } from "../src/grant/executor.ts";

const executor: ExecutorSpec = { create: () => ({}) as never };

test("defineAgent fills defaults and refuses a bad name, a battery twice, or a core action name", () => {
  const grant = defineAgent({ name: "frog-1", executor, batteries: [bash()] });
  expect(isGrant(grant)).toBe(true);
  expect(grant).toMatchObject({ manifest: "./manifest.md", cwd: ".", inception: { rounds: 5 } });
  expect(() => defineAgent({ name: "Frog" as never, executor })).toThrow(/kebab-case/);
  expect(() => defineAgent({ name: "frog", executor, batteries: [bash(), bash()] })).toThrow(/granted twice/);
  expect(() => defineAgent({ name: "frog", executor, actions: [{ state: null, name: "reply" }] })).toThrow(/core action/);
});

test("core actions: reply once through the runtime, compact emits a horizon, update_state writes by address", async () => {
  const replies: unknown[] = [];
  const [reply, compact, updateState] = coreActions({
    reply: (id, r) => (replies.push([id, r]), replies.length > 1 ? `${id} already answered` : null),
    stateSchema: (key) => (key === "notes" ? { type: "object", properties: { lines: { type: "array" } } } : undefined),
  });
  expect(await reply!.run!({ id: "r1", ok: true, text: "done" }, {})).toBe("replied to r1");
  expect(replies[0]).toEqual(["r1", { ok: true, state: "completed", text: "done" }]);
  expect(await reply!.run!({ id: "r1", ok: false, text: "again", state: "rejected" }, {})).toMatchObject({ success: false, error: expect.stringMatching(/already answered/) });

  const compacted = await compact!.run!({ summary: "open: r2" }, {});
  expect(compacted.messages.map((m: { type: string }) => m.type)).toEqual(["horizon", "user"]);
  expect(compacted.messages[1].text).toContain("open: r2");

  const writes: unknown[] = [];
  const ctx = { updateStateAt: (target: unknown, update: unknown) => void writes.push([target, update]) };
  expect(await updateState!.run!({ state: "notes", op: "patch", value: { standing: ["x"] } }, ctx)).toBe("patch notes");
  expect(writes[0]).toEqual(["notes", { op: "patch", value: { standing: ["x"] }, path: undefined }]);
  const rejecting = { updateStateAt: () => { throw new SchemaError([{ message: "expected array" }]); } };
  expect(await updateState!.run!({ state: "notes", op: "replace", value: 1 }, rejecting)).toMatchObject({ success: false, error: expect.stringMatching(/notes: expected array\nthe value must satisfy this schema: \{"type":"object"/) });
});

test("the bash battery runs in the granted cwd", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "endo-")));
  const [action] = bash().actions!({ name: "t", cwd, charter: () => { throw new Error("no charter"); } });
  expect(await action!.run!({ cmd: "pwd; echo err >&2; exit 2" }, {})).toBe(`exit 2\n${cwd}\nerr`);
});
