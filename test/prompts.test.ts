import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryProblem } from "../src/cli/prompts.ts";

test("the repository prompt refuses a directory that already holds an agent and points at it for resuming", () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-prompts-"));
  try {
    writeFileSync(join(dir, "file"), "");
    expect(repositoryProblem(".endodev", "", dir)).toBeUndefined();
    expect(repositoryProblem(".endodev", join(dir, "file"))).toBeString();
    expect(repositoryProblem(".endodev", join(dir, "missing"))).toBeString();
    mkdirSync(join(dir, ".endodev"));
    expect(repositoryProblem(".endodev", dir)).toContain(join(dir, ".endodev"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
