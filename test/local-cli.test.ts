import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cli = join(import.meta.dir, "../src/cli/index.ts");

async function fixture(installed: boolean) {
  const root = mkdtempSync(join(tmpdir(), "endo-local-cli-"));
  dirs.push(root);
  const dir = join(root, "agent");
  mkdirSync(dir);
  const pkg = installed ? join(dir, "node_modules/endograph") : join(root, "fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "endograph", version: "1.0.0", bin: { endo: "cli.ts" } }));
  writeFileSync(join(pkg, "cli.ts"), 'console.log("LOCAL:" + JSON.stringify(process.argv.slice(2)));');
  writeFileSync(join(dir, "endograph.toml"), 'name="local-test"\n[executor]\nbackend="codex"\n');
  if (!installed) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { endograph: "file:../fixture" } }));
    const seed = Bun.spawn([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    expect(await seed.exited).toBe(0);
  }
  return dir;
}

test.each(["status", "send", "up"])("%s hands off to the installed local CLI before loading the agent", async (command) => {
  const dir = await fixture(true);
  const args = [command, "--agent", dir, ...(command === "send" ? ["hello"] : [])];
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(out.trim()).toBe("LOCAL:" + JSON.stringify(args));
});

test("up installs the lockfile before handing off, so a stale local CLI never runs startup", async () => {
  const dir = await fixture(false);
  const stale = join(dir, "node_modules/endograph");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "package.json"), JSON.stringify({ name: "endograph", version: "0.9.0", bin: { endo: "cli.ts" } }));
  writeFileSync(join(stale, "cli.ts"), 'console.log("STALE");');
  const before = readFileSync(join(dir, "bun.lock"));
  const child = Bun.spawn([process.execPath, cli, "up", "--agent", dir, "--foreground"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(out).not.toContain("STALE");
  expect(out).toContain("LOCAL:" + JSON.stringify(["up", "--agent", dir, "--foreground"]));
  expect(readFileSync(join(dir, "bun.lock"))).toEqual(before);
});
