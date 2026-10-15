import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessOrder } from "../src/inception/harnesses.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cli = join(import.meta.dir, "../src/cli/index.ts");

/** A machine with only the named harnesses on PATH and its own Endograph home. */
function machine(installed: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "endo-harness-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  // Bun's own bin directory may hold a real codex; expose only bun itself.
  symlinkSync(process.execPath, join(dir, "bin", "bun"));
  for (const name of installed) {
    writeFileSync(join(dir, "bin", name), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", name), 0o755);
  }
  const home = join(dir, "home");
  const env = { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ENDOGRAPH_HOME: home };
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  // Bun.which reads the PATH the process started with, so each machine's choices run in one child.
  const choose = (...cases: [requested?: string, previous?: string][]) => {
    const script = `import { chooseHarness } from ${JSON.stringify(join(import.meta.dir, "../src/inception/harnesses.ts"))};
      console.log(JSON.stringify(${JSON.stringify(cases)}.map(([r, p]) => { try { return chooseHarness(r ?? undefined, p ?? undefined); } catch (e) { return "error: " + e.message; } })));`;
    return JSON.parse(Bun.spawnSync([process.execPath, "-e", script], { env, stdout: "pipe" }).stdout.toString()) as string[];
  };
  return { home, run, choose };
}

test("Codex is the default and Claude the fallback; an explicit harness must be installed; a stored conversation's harness is preferred", () => {
  expect(machine(["codex", "claude"]).choose([], [undefined, "claude"])).toEqual(["codex", "claude"]);
  const [fallback, explicit, stored] = machine(["claude"]).choose([], ["codex"], [undefined, "codex"]);
  expect([fallback, stored]).toEqual(["claude", "claude"]);
  expect(explicit).toStartWith("error: Codex is not installed");
  expect(machine([]).choose([])[0]).toStartWith("error: No coding agent found");
});

test("endo harness sets the machine default that orders harness choice", () => {
  const m = machine(["codex", "claude"]);
  const home = process.env.ENDOGRAPH_HOME;
  process.env.ENDOGRAPH_HOME = m.home;
  try {
    expect(harnessOrder()).toEqual(["codex", "claude"]);
    expect(m.run("harness", "claude")).toContain("default harness: claude\n");
    expect(harnessOrder()).toEqual(["claude", "codex"]);
  } finally {
    if (home === undefined) delete process.env.ENDOGRAPH_HOME; else process.env.ENDOGRAPH_HOME = home;
  }
});
