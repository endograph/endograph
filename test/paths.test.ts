import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";

test("new agents ignore all host-local state while retaining durable files", () => {
  const directory = mkdtempSync(join(tmpdir(), "endo-ignore-"));
  try {
    expect(Bun.spawnSync(["git", "init", "--quiet", directory]).exitCode).toBe(0);
    ensureStateDir(pathsOf(directory));
    const files = [".endo/local/executors/codex/session.json", ".endo/local/executors/other/session.json", ".endo/local/runtime", ".endo/frames/0001.jsonl", ".endo/checkpoint.db", ".endo/src/local/note.md"];
    const result = Bun.spawnSync(["git", "check-ignore", "--stdin"], { cwd: directory, stdin: Buffer.from(files.join("\n") + "\n") });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual(files.slice(0, 3));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
