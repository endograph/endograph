import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Loop } from "../src/loop/loop.ts";
import type { Drift, Outcome } from "../src/loop/types.ts";
import { parseEntry } from "../src/playbook/parse.ts";
import { openMemoryStore } from "../src/store/memory.ts";
import { openWorld } from "../src/world/world.ts";

const rule = (script: string, onFailure = "judge") =>
  parseEntry("/x/r.md", `+++\nkind = "rule"\non = "probe.*"\non_failure = "${onFailure}"\n+++\n\n\`\`\`sh\n${script}\n\`\`\`\n`);

async function setup(entries: ReturnType<typeof parseEntry>[], judge?: (d: Drift) => Promise<Outcome>) {
  const store = openMemoryStore();
  const world = await openWorld(store);
  const dir = mkdtempSync(join(tmpdir(), "endo-"));
  const loop = new Loop({ world, sensors: [], playbook: () => entries, scripts: { cwd: dir, home: dir, src: dir }, judge });
  return { store, world, loop };
}

test("a matching rule handles the drift and settles it once", async () => {
  const { store, loop } = await setup([rule("echo fixed")]);
  const settled: Outcome[] = [];
  await loop.handle({ kind: "probe.failed", subject: "p:1", summary: "down", observedAt: 1, settle: (o) => settled.push(o) });
  expect(settled).toEqual([{ ok: true, summary: "fixed", detail: "fixed" }]);
  expect(store.read(0).map((f) => f.type)).toEqual(["drift", "action", "outcome"]);
});

test("no rule and no judge records an escalation", async () => {
  const { store, loop } = await setup([]);
  await loop.handle({ kind: "probe.failed", subject: "p:1", summary: "down", observedAt: 1 });
  expect(store.read(0).map((f) => f.type)).toEqual(["drift", "escalation"]);
});

test("a failing rule falls through to judgment with its output; a refusal does not", async () => {
  const judged: Drift[] = [];
  const judge = async (d: Drift) => (judged.push(d), { ok: true, summary: "judged" });
  const { loop } = await setup([rule("echo broken; exit 1")], judge);
  const settled: Outcome[] = [];
  await loop.handle({ kind: "probe.failed", subject: "p:1", summary: "down", observedAt: 1, settle: (o) => settled.push(o) });
  expect(judged.length).toBe(1);
  expect(settled[0]?.summary).toBe("judged");

  const refusing = await setup([rule("echo no; exit 77")], judge);
  await refusing.loop.handle({ kind: "probe.failed", subject: "p:2", summary: "down", observedAt: 1, settle: (o) => settled.push(o) });
  expect(judged.length).toBe(1);
  expect(settled[1]).toMatchObject({ ok: false, refused: true, summary: "no" });
});

test("exit 75 leaves the drift unsettled", async () => {
  const { loop } = await setup([rule("echo started; exit 75")]);
  let settled = false;
  await loop.handle({ kind: "probe.failed", subject: "p:1", summary: "down", observedAt: 1, settle: () => (settled = true) });
  expect(settled).toBe(false);
});
