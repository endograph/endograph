import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "../src/agent/define.ts";
import { normalizeSchema } from "@projectors/core";
import { z } from "zod";
import { acquireLock, createHome, isRunning, readDeclarationLink } from "../src/agent/home.ts";
import { claim, findByDeclaration, lookup, NameConflict } from "../src/agent/registry.ts";
import { bash } from "../src/batteries/bash.ts";
import { playbook } from "../src/batteries/playbook.ts";

function declaration(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-decl-"));
  writeFileSync(join(dir, "endograph.ts"), "export default {}\n");
  return dir;
}

test("defineAgent validates the name, merges tools, rejects duplicates", async () => {
  expect(() => defineAgent({ name: "Bad Name" })).toThrow(/kebab-case/);
  const agent = defineAgent({ name: "minder", batteries: [bash(), playbook()] });
  expect(agent.tools.map((t) => t.name)).toEqual(["world", "compact", "resolve", "escalate", "bash", "write_procedure", "write_rule", "try_rule"]);
  expect(agent.childActions).toEqual([]);
  const { evolvable } = await import("../src/judge/evolve.ts");
  const evo = defineAgent({ name: "evo", children: [evolvable()] });
  expect(evo.childActions.map((a) => a.name)).toEqual(["transition", "spawn", "cede"]);
  expect(() => defineAgent({ name: "dup", children: [evolvable(), evolvable()] })).toThrow(/declared twice|registered twice/);
  expect(() => defineAgent({ name: "x", batteries: [bash(), bash()] })).toThrow(/registered twice/);
});

test("a default home links relatively; an outside home links absolutely", () => {
  const decl = declaration();
  const inside = createHome(join(decl, ".endo", "minder"), decl);
  expect(readlinkSync(join(inside.root, "declaration"))).toBe("../..");
  expect(readDeclarationLink(inside.root)).toBe(realpathSync(decl));
  const outside = createHome(join(mkdtempSync(join(tmpdir(), "endo-home-")), "m"), decl);
  expect(readlinkSync(join(outside.root, "declaration")).startsWith("/")).toBe(true);
});

test("the lock is exclusive and released", () => {
  const home = createHome(join(declaration(), ".endo", "m"), declaration());
  const lock = acquireLock(home.lockPath);
  expect(lock).not.toBeNull();
  expect(isRunning(home.lockPath)).toBe(true);
  expect(acquireLock(home.lockPath)).toBeNull();
  lock!.release();
  expect(isRunning(home.lockPath)).toBe(false);
});

test("registry: claim, reverse lookup by declaration, conflict with an existing home, rename cleanup", () => {
  process.env.ENDOGRAPH_HOME = mkdtempSync(join(tmpdir(), "endo-reg-"));
  const declA = declaration();
  const homeA = createHome(join(declA, ".endo", "minder"), declA);
  claim("minder", homeA.root);
  expect(lookup("minder")?.exists).toBe(true);
  expect(findByDeclaration(declA)?.name).toBe("minder");
  claim("minder", homeA.root); // idempotent

  const declB = declaration();
  const homeB = createHome(join(declB, ".endo", "minder"), declB);
  expect(() => claim("minder", homeB.root)).toThrow(NameConflict);

  claim("tender", homeA.root); // renamed: the old entry pointing at the same home goes
  expect(lookup("minder")).toBeNull();
  expect(lookup("tender")?.exists).toBe(true);
  mkdirSync(join(declB, "x"));
});

test("a declared world types the world tool; permissive schemas admit extra keys, strict ones do not", () => {
  const loose = defineAgent({ name: "l", world: z.looseObject({ installed: z.object({ ref: z.string() }).optional(), up: z.boolean().optional() }) });
  const tool = normalizeSchema(loose.tools.find((t) => t.name === "world")!.inputSchema!);
  expect(tool.accepts({ set: { installed: { ref: "abc" }, anything: 1 } })).toBe(true);
  expect(tool.accepts({ set: { up: "yes" } })).toBe(false);
  expect(tool.accepts({ clear: ["installed"] })).toBe(true);

  const strict = defineAgent({ name: "s", world: z.strictObject({ up: z.boolean().optional() }) });
  expect(normalizeSchema(strict.tools.find((t) => t.name === "world")!.inputSchema!).accepts({ set: { anything: 1 } })).toBe(false);

  expect(() => defineAgent({ name: "bad", world: z.strictObject({ up: z.boolean() }) })).toThrow(/world init/);
  expect(defineAgent({ name: "ok", world: { schema: z.strictObject({ up: z.boolean() }), init: { up: false } } }).world.init).toEqual({ up: false });
});
