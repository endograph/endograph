import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentHost } from "../src/host/agent.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { describeGrant } from "../src/inception/workspace.ts";
import { incept, inceptionStatus, validateProgram, type RuntimeLoadInput, type RuntimeLoader } from "../src/inception/incept.ts";
import type { SerializedInstance } from "@projectors/core";
import { promote, recoverPromotion } from "../src/inception/promotion.ts";
import { allFrames } from "../src/store/types.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { newId, waitForReply, writeMessage } from "../src/protocol/wire.ts";

const root = resolve(import.meta.dir, "..");
const program = `// .endo/program/agent.ts — written by inception 1 (2026-09-04). Do not edit:
// change manifest.md or endograph.toml and run \`endo incept\`.
import { createNode, createSourceInstance, defineProgram, tool } from "endograph";
export default defineProgram((endo) => {
  const node = createNode({ key: "test", instructions: "reply", parts: Object.values(endo.actions).map((a) => tool(a)), runtime: { type: "generator", trigger: { type: "actor-frame" } } });
  return { nodes: [node], instance: createSourceInstance({ id: "agent", node }) };
});
`;
function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), "endo-inception-"));
  mkdirSync(join(dir, ".endo/program"), { recursive: true });
  mkdirSync(join(dir, ".endo/src/procedures"), { recursive: true });
  writeFileSync(join(dir, "manifest.md"), "Answer questions.");
  writeFileSync(join(dir, "endograph.toml"), 'name="fixture"\nbatteries=["bash"]\n[executor]\nmodule=".endo/scripted.ts"\n');
  writeFileSync(join(dir, ".endo/scripted.ts"), readFileSync(join(root, "test/fixtures/agent/scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  writeFileSync(join(dir, ".endo/program/agent.ts"), program);
  writeFileSync(join(dir, ".endo/src/notes.md"), "runtime-written work");
  return dir;
}

test("failed inceptors preserve active files; manual editing happens in the candidate", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const bad = join(dir, "bad.ts");
  writeFileSync(bad, `import { writeFileSync } from "node:fs"; writeFileSync(".endo/program/agent.ts", "broken"); writeFileSync(".endo/src/notes.md", "lost"); process.exit(3);`);
  try {
    await expect(incept({ agentDir: dir, inceptor: `${process.execPath} ${bad}` })).rejects.toThrow("exited 3");
    expect(readFileSync(paths.program, "utf8")).toBe(program);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    expect(readFileSync(join(paths.inceptions, "1/rounds/1/agent.ts"), "utf8")).toBe("broken");
    const manual = await incept({ agentDir: dir, manual: true });
    const staged = join(manual.workspace, "../program/agent.ts");
    writeFileSync(staged, "invalid candidate");
    await expect(incept({ agentDir: dir, accept: true })).rejects.toThrow("inception failed");
    expect(readFileSync(paths.program, "utf8")).toBe(program);
    writeFileSync(staged, program);
    await incept({ agentDir: dir, accept: true });
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    expect(existsSync(join(paths.snapshots, "1/agent.ts"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("inceptor output streams before exit and remains intact in the round record", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const release = join(dir, "release");
  const script = join(dir, "stream.ts");
  const lines: string[] = [];
  writeFileSync(script, `
    import { existsSync } from "node:fs";
    process.stdout.write("ready\\ncaf");
    process.stderr.write("waiting\\n");
    const deadline = Date.now() + 2000;
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) process.exit(4);
      await Bun.sleep(10);
    }
    const tail = Buffer.from("é tail");
    process.stdout.write(tail.subarray(0, 1));
    await Bun.sleep(10);
    process.stdout.write(tail.subarray(1));
    process.exit(3);
  `);
  try {
    await expect(incept({ agentDir: dir, inceptor: `${process.execPath} ${script}`, log: line => {
      lines.push(line);
      if (line === "  | ready") writeFileSync(release, "continue");
    } })).rejects.toThrow("exited 3");
    expect(lines).toContain("  | café tail");
    expect(lines).toContain("  | waiting");
    expect(readFileSync(join(paths.inceptions, "1/rounds/1/stdout.txt"), "utf8")).toBe("ready\ncafé tail");
    expect(readFileSync(join(paths.inceptions, "1/rounds/1/stderr.txt"), "utf8")).toBe("waiting\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("auto inception starts a fresh worker with revoked bash, new executor, cwd and inception mode", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const executor = (label: string) => `import { scripted } from "./scripted.ts";
    export default { create() {
      let bash = false;
      const base = scripted(async turn => {
        for (const r of turn.requests) await turn.call("reply", {id:r.id,ok:true,text:JSON.stringify({pid:process.pid,executor:${JSON.stringify(label)},bash})});
      });
      return {...base,run(request) {bash=request.inference.tools.some(t=>t.name==="bash");return base.run(request);}};
    }};`;
  writeFileSync(join(paths.state, "old-executor.ts"), executor("original"));
  writeFileSync(paths.grant, readFileSync(paths.grant, "utf8").replace(".endo/scripted.ts", ".endo/old-executor.ts"));
  writeFileSync(join(paths.procedures, "where.ts"), 'import { procedure } from "endograph/procedure"; await procedure({ description: "cwd", expose: true }); console.log(process.cwd());');
  const host = await createAgentHost({ agentDir: dir, inceptor: "true", log: () => {} });
  let running: Promise<number> | undefined;
  const report = async () => {
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text: "report", at: Date.now() });
    const reply = await waitForReply(paths.outbox, id, { timeoutMs: 20000, pollMs: 25, terminal: true });
    expect(reply?.ok).toBe(true);
    return JSON.parse(reply!.text);
  };
  try {
    await incept({ agentDir: dir, inceptor: "true", loadRuntime: host.loadRuntime });
    running = host.run();
    const before = await report();
    expect(before).toMatchObject({ executor: "original", bash: true });
    mkdirSync(join(dir, "work"));
    writeFileSync(join(paths.state, "new-executor.ts"), executor("replacement"));
    writeFileSync(paths.grant, 'name="fixture"\ncwd="work"\nbatteries=[]\n[executor]\nmodule=".endo/new-executor.ts"\n[inception]\nmode="manual"\n');
    const deadline = Date.now() + 20000;
    while (!existsSync(join(paths.snapshots, "2/instance.json")) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(join(paths.snapshots, "2/instance.json"))).toBe(true);
    const after = await report();
    expect(after).toMatchObject({ executor: "replacement", bash: false });
    expect(after.pid).not.toBe(before.pid);
    // The new supervisor uses the revised cwd too.
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "call", id, procedure: "where", args: {}, at: Date.now() });
    expect((await waitForReply(paths.outbox, id, { timeoutMs: 10000, terminal: true }))?.text).toBe(realpathSync(join(dir, "work")));
    writeFileSync(join(dir, "manifest.md"), "A manual revision is now due.");
    await report();
    const store = openSqliteStore(paths.db);
    try { expect([...allFrames(store)].filter((f) => f.type === "inception")).toHaveLength(2); }
    finally { store.close(); }
  } finally {
    await host.close(); if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test("failed file promotion rolls back; startup recovers interrupted committed and uncommitted promotions", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  try {
    await incept({ agentDir: dir, inceptor: "true" });
    const old = readFileSync(paths.program, "utf8");
    const candidate = pathsOf(join(dir, "broken-candidate"));
    mkdirSync(join(candidate.state, "program"), { recursive: true });
    writeFileSync(candidate.program, old + "\n// new generation\n");
    // Missing candidate src fails after the program has already been copied.
    const initial = openSqliteStore(paths.db);
    const snapshot = initial.readSnapshot()!;
    initial.close();
    expect(() => promote(paths, candidate, 2, { type: "inception", summary: "candidate", at: Date.now() }, snapshot)).toThrow();
    expect(readFileSync(paths.program, "utf8")).toBe(old);
    const backup = join(paths.state, "promotion-backup");
    cpSync(join(paths.state, "program"), join(backup, "program"), { recursive: true });
    cpSync(paths.src, join(backup, "src"), { recursive: true });
    writeFileSync(join(paths.state, "promotion.json"), JSON.stringify({ token: "uncommitted", n: 2, program: true, src: true }));
    writeFileSync(paths.program, "half promoted");
    rmSync(paths.src, { recursive: true });
    recoverPromotion(paths);
    expect(readFileSync(paths.program, "utf8")).toBe(old);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    const store = openSqliteStore(paths.db);
    expect([...allFrames(store)].filter((f) => f.type === "inception")).toHaveLength(1);
    store.close();
    // A crash after the database decision keeps the promoted code, even if cleanup never ran.
    cpSync(join(paths.state, "program"), join(backup, "program"), { recursive: true });
    cpSync(paths.src, join(backup, "src"), { recursive: true });
    writeFileSync(join(paths.state, "promotion.json"), JSON.stringify({ token: "committed", n: 2, program: true, src: true }));
    writeFileSync(paths.program, old + "\n// committed generation\n");
    const committed = openSqliteStore(paths.db);
    committed.append({ type: "inception", summary: "committed", at: Date.now(), payload: { n: 2, promotion: "committed" } });
    committed.close();
    recoverPromotion(paths);
    expect(readFileSync(paths.program, "utf8")).toContain("committed generation");
    expect(existsSync(join(paths.state, "promotion.json"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandboxed inception delegates all program loads and refuses an unsafe local fallback", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const marker = join(dir, "generated-code-ran-in-parent");
  try {
    await incept({ agentDir: dir, inceptor: "true" });
    const store = openSqliteStore(paths.db);
    const state = store.readSnapshot()!.state as SerializedInstance;
    store.close();
    writeFileSync(paths.program, program + `\nawait Bun.write(${JSON.stringify(marker)}, "unsafe");\n`);
    // Metadata inspection must not execute the program, even without a sandbox policy.
    expect((await inceptionStatus(paths)).n).toBe(1);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(paths.grant, readFileSync(paths.grant, "utf8") + '\n[sandbox]\nnetwork="offline"\n');
    const grant = await loadGrant(paths);
    expect(await validateProgram({ paths, grant })).toMatchObject({ ok: false, error: expect.stringContaining("isolated runtime loader") });
    await incept({ agentDir: dir, manual: true });
    await expect(incept({ agentDir: dir, accept: true })).rejects.toThrow("isolated runtime loader");
    expect(existsSync(marker)).toBe(false);

    const loads: RuntimeLoadInput[] = [];
    const candidates: SerializedInstance[] = [];
    const loadRuntime: RuntimeLoader = async (input) => {
      loads.push(input);
      const loaded = { ...state, id: `validated-${loads.length}` };
      if (input.paths.agentDir.includes("candidate")) candidates.push(loaded);
      return { state: loaded, failures: [] };
    };
    expect(await validateProgram({ paths, grant, loadRuntime })).toMatchObject({ ok: true });
    await incept({ agentDir: dir, manual: true, loadRuntime });
    await incept({ agentDir: dir, accept: true, loadRuntime });
    expect(loads.every((input) => input.ownerPaths.agentDir === paths.agentDir)).toBe(true);
    // Promotion must keep the instance that passed validation. A second
    // invocation of generated code could construct a different instance.
    expect(candidates).toHaveLength(1);
    const promoted = openSqliteStore(paths.db);
    try { expect(promoted.readSnapshot()?.state).toEqual(candidates[0]); }
    finally { promoted.close(); }
    expect(JSON.parse(readFileSync(join(paths.snapshots, "2/instance.json"), "utf8"))).toEqual(candidates[0]);
    expect(existsSync(marker)).toBe(false);
    expect((await inceptionStatus(paths)).n).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manual inception describes plain grant data without binding an executor or host proxy", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const marker = join(dir, "executor-imported");
  writeFileSync(join(paths.state, "scripted.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); throw new Error("metadata must not import this executor");`);
  writeFileSync(paths.grant, 'name="fixture"\nbatteries=["bash", "scheduler"]\nhost_actions=["sentryApi"]\n[executor]\nmodule=".endo/scripted.ts"\n');
  writeFileSync(join(paths.state, "host-actions.json"), JSON.stringify([{ name: "sentryApi", description: "Read one issue", inputSchema: { type: "object", properties: { issueId: { type: "string" } }, required: ["issueId"] } }]));
  try {
    const grant = await loadGrant(paths);
    const description = describeGrant(paths, grant);
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    expect(description.actions.find((action) => action.name === "sentryApi")).toMatchObject({ description: "Read one issue" });
    expect(description.actions.every((action) => !("run" in action))).toBe(true);
    expect(description.batteries.find((battery) => battery.name === "scheduler")?.fields.map((field) => field.name)).toContain("schedule");
    const manual = await incept({ agentDir: dir, manual: true });
    const rendered = readFileSync(join(manual.workspace, "GRANT.md"), "utf8");
    expect(rendered).toContain("### sentryApi");
    expect(rendered).toContain("module .endo/scripted.ts");
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
