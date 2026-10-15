import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "@projectors/core";
import { coreActions } from "../src/grant/core.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { bindRuntime } from "../src/grant/bind.ts";
import { pathsOf } from "../src/harness/paths.ts";

function agentDir(toml: string, manifest = true): ReturnType<typeof pathsOf> {
  const dir = mkdtempSync(join(tmpdir(), "endo-grant-"));
  writeFileSync(join(dir, "endograph.toml"), toml);
  if (manifest) writeFileSync(join(dir, "manifest.md"), "# m\n");
  return pathsOf(dir);
}

test("grant reads are data only; runtime binding imports executors explicitly; invalid configuration is refused", async () => {
  const paths = agentDir('name = "frog-1"\nbatteries = ["bash"]\n[executor]\nprovider = "openai"\nmodel = "gpt-x"\n', false);
  await expect(loadGrant(paths)).rejects.toThrow(/no manifest: write .*manifest.md, or put it inline/);
  writeFileSync(join(paths.agentDir, "manifest.md"), "# frog\n");
  const grant = await loadGrant(paths);
  expect(grant).toMatchObject({ name: "frog-1", manifest: { text: "# frog\n", path: join(paths.agentDir, "manifest.md") }, cwd: ".", inception: { rounds: 5 } });
  const inline = await loadGrant(agentDir('name = "inline"\n[executor]\nprovider = "openai"\nmodel = "x"\n[manifest]\ntext = """\n# inline\n\nSay hi.\n"""\n', false));
  expect(inline.manifest).toEqual({ text: "# inline\n\nSay hi.\n" });
  expect(grant.batteries).toEqual(["bash"]);
  expect(grant.executor).toMatchObject({ provider: "openai", model: "gpt-x" });
  expect(structuredClone(grant)).toEqual(grant);

  const marker = join(paths.agentDir, "executor-imported");
  writeFileSync(join(paths.agentDir, "exec.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default { description: "mine", create: () => ({}) };`);
  const modulePaths = agentDir('name = "m"\n[executor]\nmodule = "./exec.ts"\n'.replace("./exec.ts", join(paths.agentDir, "exec.ts")));
  const moduleGrant = await loadGrant(modulePaths);
  expect(moduleGrant.executor).toEqual({ module: join(paths.agentDir, "exec.ts") });
  expect(existsSync(marker)).toBe(false);
  expect((await bindRuntime(modulePaths, moduleGrant)).executor.description).toBe("mine");
  expect(existsSync(marker)).toBe(true);
  const sandboxPaths = agentDir('name="offline"\nhost_actions=["sentryApi"]\nhost_modules=["host/sentry.ts"]\n[executor]\nmodule="not-imported.ts"\n[sandbox]\nnetwork="offline"\n');
  const sandboxGrant = await loadGrant(sandboxPaths);
  expect(sandboxGrant.hostActions).toEqual(["sentryApi"]);
  expect(structuredClone(sandboxGrant)).toEqual(sandboxGrant);
  await expect(bindRuntime(sandboxPaths, sandboxGrant)).rejects.toThrow("createAgentHost");

  await expect(loadGrant(agentDir('name = "Frog"\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/kebab-case/);
  await expect(loadGrant(agentDir('name = "frog"\ncolour = 1\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/colour/);
  await expect(loadGrant(agentDir('name = "frog"\nbatteries = ["nope"]\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/unknown battery "nope"; available: bash, evolve, scheduler/);
  await expect(loadGrant(agentDir('name = "frog"\nbatteries = ["bash", "bash"]\n[executor]\nprovider = "openai"\nmodel = "x"\n'))).rejects.toThrow(/listed twice/);
  await expect(loadGrant(agentDir('name = "frog"\n'))).rejects.toThrow(/executor/);
});

test("native backends parse per-backend options and bind the matching worker executor", async () => {
  const claude = agentDir('name = "c"\n[executor]\nbackend = "claude"\nmodel = "claude-sonnet-5"\neffort = "xhigh"\nmax_tool_calls = 12\n');
  const grant = await loadGrant(claude);
  expect(grant.executor).toMatchObject({ backend: "claude", model: "claude-sonnet-5", effort: "xhigh", maxToolCalls: 12 });
  expect((await bindRuntime(claude, grant)).executor.create().identity?.name).toBe("claude");
  // Effort levels are backend-specific.
  await expect(loadGrant(agentDir('name = "c"\n[executor]\nbackend = "claude"\neffort = "ultra"\n'))).rejects.toThrow(/executor/);
  expect((await loadGrant(agentDir('name = "x"\n[executor]\nbackend = "codex"\neffort = "ultra"\n'))).executor).toMatchObject({ backend: "codex", effort: "ultra" });
});

test("update_state reports a schema rejection with the state's schema", async () => {
  const [, , updateState] = coreActions({
    reply: () => null,
    stateSchema: (key) => (key === "notes" ? { type: "object", properties: { lines: { type: "array" } } } : undefined),
  });
  const rejecting = { updateStateAt: () => { throw new SchemaError([{ message: "expected array" }]); } };
  expect(await updateState!.run!({ state: "notes", op: "replace", value: 1 }, rejecting)).toMatchObject({ success: false, error: expect.stringMatching(/notes: expected array\nthe value must satisfy this schema: \{"type":"object"/) });
});
