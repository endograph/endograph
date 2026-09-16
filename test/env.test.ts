import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/harness/env.ts";
import { pathsOf } from "../src/harness/paths.ts";

test("loads owner .env relative to the agent directory with process environment taking precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-env-"));
  const key = "ENDO_TEST_OWNER_ENV";
  const before = process.env[key];
  try {
    delete process.env[key];
    const paths = pathsOf(dir);
    mkdirSync(paths.state);
    writeFileSync(join(paths.state, "env"), `${key}=legacy\n`);
    writeFileSync(join(paths.state, ".env"), `${key}=agent\n`);
    expect(loadEnv(paths)).toEqual([]);
    expect(process.env[key]).toBeUndefined();
    writeFileSync(join(dir, ".env"), `# owner credentials\n${key}="owner"\n`);
    expect(loadEnv(paths)).toEqual([key]);
    expect(process.env[key]).toBe("owner");
    process.env[key] = "inherited";
    loadEnv(paths);
    expect(process.env[key]).toBe("inherited");
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
