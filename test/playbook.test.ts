import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchRule } from "../src/playbook/match.ts";
import { loadPlaybook, parseEntry } from "../src/playbook/parse.ts";
import { runProcedure, runRule, validateArgs, type ScriptContext } from "../src/playbook/run.ts";

const RULE = `+++
kind = "rule"
on = "request.received"
match = "deploy"
+++

Deploys are scripted.

\`\`\`sh
echo "deployed $ENDO_DRIFT_SUMMARY"
\`\`\`
`;

const PROC = `+++
kind = "procedure"
description = "say hi"
expose = true

[args.NAME]
required = true
description = "who"
+++

\`\`\`sh
echo "hi $ENDO_ARG_NAME"
\`\`\`
`;

function ctx(dir: string): ScriptContext {
  return { cwd: dir, home: dir, src: join(dir, "src") };
}

describe("parse", () => {
  test("rules and procedures from frontmatter", () => {
    const rule = parseEntry("/x/scripted-deploy.md", RULE);
    expect(rule.kind).toBe("rule");
    if (rule.kind === "rule") {
      expect(rule.name).toBe("scripted-deploy");
      expect(rule.match?.test("request from x: deploy this")).toBe(true);
      expect(rule.onFailure).toBe("judge");
    }
    const proc = parseEntry("/x/hi.md", PROC);
    expect(proc.kind).toBe("procedure");
    if (proc.kind === "procedure") {
      expect(proc.expose).toBe(true);
      expect(proc.args.NAME?.required).toBe(true);
    }
  });

  test("a note without frontmatter is ignored; duplicate names are an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "endo-"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "hi.md"), PROC);
    writeFileSync(join(dir, "notes.md"), "# just notes\n");
    expect((await loadPlaybook(dir)).map((e) => e.name)).toEqual(["hi"]);
    writeFileSync(join(dir, "lib", "hi.md"), PROC);
    await expect(loadPlaybook(dir)).rejects.toThrow(/duplicate/);
  });
});

describe("run", () => {
  test("a rule sees the drift and its last line is the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "endo-"));
    const rule = parseEntry("/x/r.md", RULE);
    if (rule.kind !== "rule") throw new Error();
    const drift = { kind: "request.received", subject: "request:inc-1", summary: "deploy it", observedAt: 0 };
    expect(matchRule([rule], drift)).toBe(rule);
    const out = await runRule(rule, drift, ctx(dir));
    expect(out).toMatchObject({ ok: true, summary: "deployed deploy it" });
  });

  test("exit 77 refuses, 75 leaves it pending, other codes fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "endo-"));
    const mk = (code: number) => parseEntry("/x/r.md", RULE.replace('echo "deployed $ENDO_DRIFT_SUMMARY"', `echo nope; exit ${code}`));
    const drift = { kind: "request.received", subject: "s", summary: "deploy", observedAt: 0 };
    const r77 = mk(77);
    const r75 = mk(75);
    const r1 = mk(1);
    if (r77.kind !== "rule" || r75.kind !== "rule" || r1.kind !== "rule") throw new Error();
    expect(await runRule(r77, drift, ctx(dir))).toMatchObject({ ok: false, refused: true, summary: "nope" });
    expect(await runRule(r75, drift, ctx(dir))).toMatchObject({ ok: true, pending: true });
    const failed = await runRule(r1, drift, ctx(dir));
    expect(failed.ok).toBe(false);
    expect(failed.refused).toBeFalsy();
    expect(failed.pending).toBeFalsy();
  });

  test("procedures validate args and receive them as ENDO_ARG_*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "endo-"));
    const proc = parseEntry("/x/hi.md", PROC);
    if (proc.kind !== "procedure") throw new Error();
    expect(validateArgs(proc, {})).toMatch(/missing required arg NAME/);
    expect(validateArgs(proc, { NAME: "x", OTHER: "y" })).toMatch(/unknown arg OTHER/);
    expect(await runProcedure(proc, { NAME: "bob" }, ctx(dir))).toMatchObject({ ok: true, summary: "hi bob" });
  });
});

test("a timeout kills the whole process tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-"));
  const { runShell } = await import("../src/playbook/run.ts");
  const result = await runShell("sleep 300 & echo child=$!; wait", ctx(dir), { timeoutMs: 300 });
  const pid = Number(result.detail?.match(/child=(\d+)/)?.[1]);
  expect(result.ok).toBe(false);
  expect(result.detail).toMatch(/timed out/);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});
