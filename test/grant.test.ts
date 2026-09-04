import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "@projectors/core";
import { bash } from "../src/batteries/bash.ts";
import { coreActions } from "../src/grant/core.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { pathsOf } from "../src/harness/paths.ts";

function agentDir(toml: string, manifest = true): ReturnType<typeof pathsOf> {
  const dir = mkdtempSync(join(tmpdir(), "endo-grant-"));
  writeFileSync(join(dir, "endograph.toml"), toml);
  if (manifest) writeFileSync(join(dir, "manifest.md"), "# m\n");
  return pathsOf(dir);
}

test("loadGrant: defaults, batteries by name, a module executor; bad names, unknown keys, and unknown or repeated batteries are refused", async () => {
  const paths = agentDir('name = "frog-1"\nbatteries = ["bash"]\n[executor]\nprovider = "openai"\nmodel = "gpt-x"\n', false);
  await expect(loadGrant(paths)).rejects.toThrow(/no manifest: write .*manifest.md, or put it inline/);
  writeFileSync(join(paths.agentDir, "manifest.md"), "# frog\n");
  const grant = await loadGrant(paths);
  expect(grant).toMatchObject({ name: "frog-1", manifest: { text: "# frog\n", path: join(paths.agentDir, "manifest.md") }, cwd: ".", inception: { rounds: 5 } });
  const inline = await loadGrant(agentDir('name = "inline"\n[executor]\nprovider = "openai"\nmodel = "x"\n[manifest]\ntext = """\n# inline\n\nSay hi.\n"""\n', false));
  expect(inline.manifest).toEqual({ text: "# inline\n\nSay hi.\n" });
  expect(grant.batteries.map((b) => b.name)).toEqual(["bash"]);
  expect(grant.executor.description).toBe("aisdk openai gpt-x");

  writeFileSync(join(paths.agentDir, "exec.ts"), "export default { description: \"mine\", create: () => ({}) };\n");
  expect((await loadGrant(agentDir('name = "m"\n[executor]\nmodule = "./exec.ts"\n'.replace("./exec.ts", join(paths.agentDir, "exec.ts"))))).executor.description).toBe("mine");

  await expect(loadGrant(agentDir('name = "Frog"\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/kebab-case/);
  await expect(loadGrant(agentDir('name = "frog"\ncolour = 1\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/colour/);
  await expect(loadGrant(agentDir('name = "frog"\nbatteries = ["nope"]\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/unknown battery "nope"; available: bash, evolve, scheduler/);
  await expect(loadGrant(agentDir('name = "frog"\nbatteries = ["bash", "bash"]\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/listed twice/);
  await expect(loadGrant(agentDir('name = "frog"\n'))).rejects.toThrow(/executor/);
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
