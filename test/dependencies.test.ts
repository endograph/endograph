import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDependencies } from "../src/cli/dependencies.ts";
import { acquireLock } from "../src/harness/lock.ts";

test.each(["bun", "npm"])("up installs missing dependencies from the %s lockfile without changing versions", async (manager) => {
  const dir = mkdtempSync(join(tmpdir(), "endo-install-"));
  try {
    mkdirSync(join(dir, "fixture"));
    writeFileSync(join(dir, "fixture/package.json"), JSON.stringify({ name: "local-fixture", version: "1.0.0" }));
    const manifest = JSON.stringify({ name: "install-test", private: true, dependencies: { "local-fixture": "file:./fixture" } });
    writeFileSync(join(dir, "package.json"), manifest);
    const seed = Bun.spawn(manager === "bun"
      ? [process.execPath, "install", "--lockfile-only", "--ignore-scripts"]
      : ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: dir, stdout: "ignore", stderr: "pipe" });
    const errors = await new Response(seed.stderr).text();
    expect({ code: await seed.exited, errors: manager === "npm" ? errors : "" }).toEqual({ code: 0, errors: "" });
    const file = join(dir, manager === "bun" ? "bun.lock" : "package-lock.json");
    const locked = readFileSync(file);
    for (let i = 0; i < 2; i++) {
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      await installDependencies(dir);
      expect(JSON.parse(readFileSync(join(dir, "node_modules/local-fixture/package.json"), "utf8")).version).toBe("1.0.0");
      expect(readFileSync(file)).toEqual(locked);
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(manifest);
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "install-test", private: true,
      dependencies: { "local-fixture": "file:./fixture", "another-fixture": "file:./fixture" } }));
    await expect(installDependencies(dir)).rejects.toThrow("dependency installation failed");
    expect(readFileSync(file)).toEqual(locked);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

test("up refuses to install underneath a running agent and skips directories without a manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-install-lock-"));
  const lock = acquireLock(join(dir, ".endo", "lock"))!;
  try {
    await installDependencies(dir);
    writeFileSync(join(dir, "package.json"), '{"private":true}');
    await expect(installDependencies(dir)).rejects.toThrow("agent is running");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  } finally { lock.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("a failed install aborts up before host modules load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-install-fail-"));
  try {
    writeFileSync(join(dir, "package.json"), "invalid JSON");
    writeFileSync(join(dir, "endograph.toml"), 'name="install-fail"\nhost_modules=["host.ts"]\n[executor]\nprovider="openai"\nmodel="unused"\n');
    const marker = join(dir, "host-loaded");
    writeFileSync(join(dir, "host.ts"), `await Bun.write(${JSON.stringify(marker)}, "loaded"); export default [];`);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/index.ts"), "up", "--foreground"], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(errors).toContain("dependency installation failed");
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
