import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, list, lookup, NameConflict, resolveAgent } from "../src/cli/registry.ts";

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-agent-"));
  writeFileSync(join(dir, "endograph.ts"), "export default {}\n");
  return dir;
}

test("registry: claim, conflict while the holder exists, takeover when it is gone, rename, lookup by name or path", () => {
  process.env.ENDOGRAPH_HOME = mkdtempSync(join(tmpdir(), "endo-home-"));
  const a = agentDir();
  claim("minder", a);
  claim("minder", a);
  expect(lookup("minder")?.exists).toBe(true);
  expect(resolveAgent("minder")).toBe(lookup("minder")!.dir);
  expect(resolveAgent(a)).toBe(a);
  expect(resolveAgent("nobody")).toBeNull();

  const b = agentDir();
  expect(() => claim("minder", b)).toThrow(NameConflict);
  rmSync(a, { recursive: true });
  claim("minder", b);
  expect(lookup("minder")?.dir).toContain(b.split("/").pop()!);

  claim("tender", b);
  expect(lookup("minder")).toBeNull();
  expect(list().map((e) => e.name)).toEqual(["tender"]);
  mkdirSync(join(b, "x"));
});
