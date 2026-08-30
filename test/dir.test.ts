import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentDir } from "../src/agent/dir.ts";

let root!: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "endograph-dir-"));
  mkdirSync(join(root, "proj", ".minder"), { recursive: true });
  writeFileSync(join(root, "proj", ".minder", "endograph.toml"), "");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveAgentDir", () => {
  test("a name resolves inside the project", () => {
    const dir = resolveAgentDir(join(root, "proj"), "minder");
    expect(dir.name).toBe("minder");
    expect(dir.inboxDir).toBe(join(root, "proj", ".minder", "inbox"));
  });

  test("a path resolves from anywhere", () => {
    const arbitrary = join(root, "proj", "operations-agent");
    mkdirSync(arbitrary);
    writeFileSync(join(arbitrary, "endograph.toml"), "");
    const dir = resolveAgentDir("/", arbitrary);
    expect(dir.name).toBe("operations-agent");
    expect(dir.project).toBe(join(root, "proj"));
  });

  test("the single agent in a project is the default", () => {
    expect(resolveAgentDir(join(root, "proj")).name).toBe("minder");
  });

  test("a path without endograph.toml is rejected", () => {
    expect(() => resolveAgentDir("/", join(root, "proj"))).toThrow(/not an agent directory/);
  });

  test("endograph.toml must be a file", () => {
    const invalid = join(root, "proj", "invalid");
    mkdirSync(join(invalid, "endograph.toml"), { recursive: true });
    expect(() => resolveAgentDir("/", invalid)).toThrow(/missing endograph.toml/);
  });
});
