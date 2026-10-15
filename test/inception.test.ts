import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentHost } from "../src/host/agent.ts";
import { acquireLock } from "../src/harness/lock.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { describeGrant } from "../src/inception/workspace.ts";
import { incept, inceptionStatus, validateProgram, type RuntimeLoadInput, type RuntimeLoader } from "../src/inception/incept.ts";
import type { SerializedInstance } from "@projectors/core";
import { SandboxManager } from "@endograph/sandbox-runtime";
import { promote, recoverPromotion } from "../src/inception/promotion.ts";
import { protectInceptor } from "../src/inception/sandbox.ts";
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
    // Manual mode: a manifest edit never incepts. Polls run serially, each checking inputs before serving and
    // incepting after; the second report's poll sees the edit, so the third is served after any auto inception.
    writeFileSync(join(dir, "manifest.md"), "A manual revision is now due.");
    for (let i = 0; i < 3; i++) await report();
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
    cpSync(paths.grant, join(backup, "owner-0"));
    const oldConfig = readFileSync(paths.grant, "utf8");
    writeFileSync(join(paths.state, "promotion.json"), JSON.stringify({ token: "uncommitted", n: 2, program: true, src: true, ownerFiles: [{ path: paths.grant, existed: true }, { path: join(dir, "new-manifest.md"), existed: false }] }));
    writeFileSync(paths.grant, "half promoted config");
    writeFileSync(join(dir, "new-manifest.md"), "half promoted manifest");
    writeFileSync(paths.program, "half promoted");
    rmSync(paths.src, { recursive: true });
    recoverPromotion(paths);
    expect(readFileSync(paths.grant, "utf8")).toBe(oldConfig);
    expect(existsSync(join(dir, "new-manifest.md"))).toBe(false);
    expect(readFileSync(paths.program, "utf8")).toBe(old);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    const store = openSqliteStore(paths.db);
    expect([...allFrames(store)].filter((f) => f.type === "inception")).toHaveLength(1);
    store.close();
    // A crash after the database decision keeps the promoted code, even if cleanup never ran.
    cpSync(join(paths.state, "program"), join(backup, "program"), { recursive: true });
    cpSync(paths.src, join(backup, "src"), { recursive: true });
    cpSync(paths.grant, join(backup, "owner-0"));
    writeFileSync(join(paths.state, "promotion.json"), JSON.stringify({ token: "committed", n: 2, program: true, src: true, ownerFiles: [{ path: paths.grant, existed: true }] }));
    writeFileSync(paths.grant, oldConfig + "\n# committed owner edit\n");
    writeFileSync(paths.program, old + "\n// committed generation\n");
    const committed = openSqliteStore(paths.db);
    committed.append({ type: "inception", summary: "committed", at: Date.now(), payload: { n: 2, promotion: "committed" } });
    committed.close();
    recoverPromotion(paths);
    expect(readFileSync(paths.program, "utf8")).toContain("committed generation");
    expect(readFileSync(paths.grant, "utf8")).toContain("committed owner edit");
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
    await incept({ agentDir: dir, manual: true });
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const nativeThread = "12345678-1234-1234-1234-123456789abc";
const native = { harness: "codex", threadId: nativeThread } as const;

test("setup context seeds only the first inception and never replaces a pending conversation", async () => {
  const dir = scaffold();
  const otherThread = "87654321-1234-1234-1234-123456789abc";
  try {
    await expect(incept({ agentDir: dir, initialSession: native, interactive: async (session) => {
      expect(session.previous).toEqual(native);
      throw new Error("owner left");
    } })).rejects.toThrow("owner left");
    await incept({ agentDir: dir, initialSession: { harness: "codex", threadId: otherThread }, interactive: async (session) => {
      expect(session.previous).toEqual(native);
    } });
    await incept({ agentDir: dir, initialSession: native, interactive: async (session) => {
      expect(session.previous).toBeUndefined();
    } });
    expect((await inceptionStatus(pathsOf(dir))).n).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive inception validates, resumes the same conversation for repairs, and promotes once", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  let sessions = 0;
  try {
    const result = await incept({ agentDir: dir, interactive: async (session) => {
      expect(acquireLock(paths.lock)).toBeNull();
      expect(session.instructions).toContain("TASK.md");
      const candidate = pathsOf(session.directory);
      if (++sessions === 1) {
        expect(session.previous).toBeUndefined();
        session.save(native);
        writeFileSync(candidate.program, "bad candidate");
      } else {
        expect(session.previous).toEqual(native);
        expect(readFileSync(join(candidate.workspace, "ERRORS.md"), "utf8")).toContain("header");
        expect(readFileSync(paths.program, "utf8")).toBe(program);
        writeFileSync(candidate.program, program);
      }
    } });
    expect("rounds" in result && result.rounds).toBe(2);
    expect((await inceptionStatus(paths)).n).toBe(1);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    expect(JSON.parse(readFileSync(join(paths.inceptions, "1/rounds/2/round.json"), "utf8")).native).toEqual(native);
    expect(existsSync(join(paths.local, "inception/session.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(paths.local, "inception/completed-1.json"), "utf8")).native).toEqual(native);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["cancel", "validation"])("interactive %s preserves candidate edits for the next invocation", async (mode) => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  writeFileSync(paths.grant, readFileSync(paths.grant, "utf8") + "[inception]\nrounds=1\n");
  try {
    await expect(incept({ agentDir: dir, interactive: async (session) => {
      session.save(native);
      const candidate = pathsOf(session.directory);
      writeFileSync(join(candidate.src, "notes.md"), "work from the conversation");
      writeFileSync(join(session.directory, "manifest.md"), "Requested draft mandate.");
      if (mode === "cancel") throw new Error("owner exited");
      writeFileSync(candidate.program, "broken");
    } })).rejects.toThrow();
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("runtime-written work");
    expect(readFileSync(join(dir, "manifest.md"), "utf8")).toBe("Answer questions.");
    expect((await inceptionStatus(paths)).n).toBe(0);
    const result = await incept({ agentDir: dir, interactive: async (session) => {
      expect(session.previous).toEqual(native);
      const candidate = pathsOf(session.directory);
      expect(readFileSync(join(candidate.src, "notes.md"), "utf8")).toBe("work from the conversation");
      expect(readFileSync(join(session.directory, "manifest.md"), "utf8")).toBe("Requested draft mandate.");
      writeFileSync(candidate.program, program);
    } });
    expect("rounds" in result && result.rounds).toBe(2);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("work from the conversation");
    expect(readFileSync(join(dir, "manifest.md"), "utf8")).toBe("Requested draft mandate.");
    expect((await inceptionStatus(paths)).changed).toEqual([]);
    expect(existsSync(join(paths.inceptions, "1/rounds/1/ERRORS.md"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a paused interactive draft is archived rather than resumed over newer agent work or replaced by a non-interactive inception", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const pause = (text: string) => expect(incept({ agentDir: dir, interactive: async (session) => {
    session.save(native);
    writeFileSync(join(pathsOf(session.directory).src, "notes.md"), text);
    throw new Error("cancelled");
  } })).rejects.toThrow("preserved");
  const archived = (text: string) => readdirSync(join(paths.local, "inception")).filter((name) => name.startsWith("previous-"))
    .map((name) => join(paths.local, "inception", name)).find((archive) => readFileSync(join(archive, "candidate/.endo/src/notes.md"), "utf8") === text);
  try {
    await pause("old candidate");
    writeFileSync(join(paths.src, "notes.md"), "newer agent work");
    await incept({ agentDir: dir, interactive: async (session) => {
      expect(session.previous).toBeUndefined();
      expect(readFileSync(join(pathsOf(session.directory).src, "notes.md"), "utf8")).toBe("newer agent work");
    } });
    expect(archived("old candidate")).toBeDefined();
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("newer agent work");
    await pause("draft from the conversation");
    await incept({ agentDir: dir, manual: true });
    expect(existsSync(join(paths.local, "inception/session.json"))).toBe(false);
    const archive = archived("draft from the conversation")!;
    expect(JSON.parse(readFileSync(join(archive, "session.json"), "utf8")).native).toEqual(native);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive publication rejects live work changed during the conversation", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  try {
    await expect(incept({ agentDir: dir, interactive: async () => {
      writeFileSync(join(paths.src, "notes.md"), "outside edit");
    } })).rejects.toThrow("changed during interactive inception");
    expect((await inceptionStatus(paths)).n).toBe(0);
    expect(readFileSync(join(paths.src, "notes.md"), "utf8")).toBe("outside edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each([["create", "codex"], ["up", "claude"]] as const)("endo %s runs interactive inception through the shared terminal and host validator (%s)", async (command, harness) => {
  const dir = scaffold();
  const paths = pathsOf(command === "create" ? join(dir, ".endodev") : dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const cli = join(root, "src/cli/index.ts");
  // Only the requested harness is installed (Bun's bin directory may hold a real codex); the fixture is shared.
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(join(bin, harness), `#!${process.execPath}
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.stdin.setRawMode(true);
    if (${JSON.stringify(harness)} === 'codex') process.env.CODEX_THREAD_ID = ${JSON.stringify(nativeThread)};
    const phase = process.env.ENDOGRAPH_SESSION_PURPOSE;
    appendFileSync(${JSON.stringify(join(dir, "sessions.jsonl"))}, JSON.stringify({ phase, args: process.argv.slice(2) }) + '\\n');
    console.log(phase === 'setup' ? 'NATIVE_SETUP' : 'NATIVE_INCEPTION');
    let input = '';
    process.stdin.on('data', chunk => { input += chunk.toString(); if (input.includes(${JSON.stringify(harness === "codex" ? "/quit\r" : "/exit\r")})) process.exit(0); });
    if (${JSON.stringify(command)} === 'create') {
      if (phase === 'setup') {
        // Avoid registry dependencies in this offline CLI fixture.
        writeFileSync(${JSON.stringify(join(paths.agentDir, "package.json"))}, JSON.stringify({ name: 'fixture', private: true }));
        writeFileSync(${JSON.stringify(join(paths.local, "setup/draft/manifest.md"))}, 'Answer questions.');
      } else {
        mkdirSync('.endo/program', {recursive:true});
        writeFileSync('.endo/program/agent.ts', ${JSON.stringify(program)});
      }
    }
    for (const action of ['ready', 'finish']) {
      const child = Bun.spawn([process.execPath, ${JSON.stringify(cli)}, phase === 'setup' ? 'setup' : 'incept', action], { stdout: 'inherit', stderr: 'inherit', env: process.env });
      if (await child.exited !== 0) process.exit(2);
    }
  `, { mode: 0o755 });
  let output = "";
  const seen = new Set<string>();
  let child: Bun.Subprocess;
  child = Bun.spawn([process.execPath, cli, command, "--harness", harness, ...(command === "create" ? ["endodev"] : ["--interactive", "--agent", dir]), "--foreground"], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ENDOGRAPH_HOME: join(dir, "registry"), TERM: "xterm-256color" },
    terminal: { cols: 120, rows: 35, data(terminal, data) {
      output += Buffer.from(data).toString();
      if (output.includes(" up in ")) child.kill("SIGTERM");
      if (command === "create") for (const marker of ["Which directory", "What would", "Ready to incept"]) {
        if (!output.includes(marker) || seen.has(marker)) continue;
        seen.add(marker);
        setTimeout(() => terminal.write(marker === "Ready to incept" ? "y\r" : "\r"), 100);
      }
    } },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), command === "create" ? 45000 : 15000);
  try {
    await child.exited;
    expect({ inception: output.includes("NATIVE_INCEPTION"), output: output.includes("NATIVE_INCEPTION") ? "" : output }).toEqual({ inception: true, output: "" });
    expect(output).toContain("inception 1 recorded");
    expect((await inceptionStatus(paths)).n).toBe(1);
    const completed = JSON.parse(readFileSync(join(paths.local, "inception/completed-1.json"), "utf8")).native;
    const sessions = readFileSync(join(dir, "sessions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const threadId = harness === "codex" ? nativeThread : sessions[0].args[sessions[0].args.indexOf("--session-id") + 1];
    expect(completed).toEqual({ harness, threadId });
    if (command === "create") {
      expect(sessions.map(session => session.phase)).toEqual(["setup", "inception"]);
      expect(sessions[1].args).toContain(harness === "codex" ? "resume" : "--resume");
      expect(sessions[1].args).toContain(threadId);
      expect(output).toContain(" up in ");
    }
  } finally { clearTimeout(timer); child.terminal?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 50000);

test("interactive candidate owner-input edits return to the native session for correction before loading code", async () => {
  const dir = scaffold();
  const marker = join(dir, "untrusted-imported");
  const untrusted = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); export default [];`;
  writeFileSync(join(dir, "untrusted.ts"), untrusted);
  let round = 0;
  try {
    await incept({ agentDir: dir, interactive: async ({ directory }) => {
      const staged = pathsOf(directory);
      if (++round === 1) {
        writeFileSync(join(directory, "untrusted.ts"), untrusted);
        writeFileSync(staged.grant, 'host_modules=["./untrusted.ts"]');
      }
      else {
        expect(readFileSync(join(staged.workspace, "ERRORS.md"), "utf8")).toContain("owner inputs:");
        cpSync(pathsOf(dir).grant, staged.grant);
      }
    } });
    expect(round).toBe(2);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive owner edits validate with final capabilities and record a matching snapshot", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const host = await createAgentHost({ agentDir: dir });
  const config = 'name="fixture"\nbatteries=[]\ncwd=".."\n[executor]\nmodule=".endo/scripted.ts"\n';
  try {
    await incept({ agentDir: dir, loadRuntime: host.loadRuntime, interactive: async ({ directory }) => {
      writeFileSync(join(directory, "manifest.md"), "Only answer questions. No bash.");
      writeFileSync(pathsOf(directory).grant, config);
      writeFileSync(pathsOf(directory).program, program.replace('const node =', 'let allowed = true; try { void endo.actions.bash; } catch { allowed = false; } if (allowed) throw new Error("stale capabilities"); const node ='));
      expect(readFileSync(paths.grant, "utf8")).not.toBe(config);
    } });
    expect(readFileSync(paths.grant, "utf8")).toBe(config);
    expect(readFileSync(join(dir, "manifest.md"), "utf8")).toBe("Only answer questions. No bash.");
    expect(readFileSync(join(paths.snapshots, "1/endograph.toml"), "utf8")).toBe(config);
    expect(readFileSync(join(paths.snapshots, "1/manifest.md"), "utf8")).toBe("Only answer questions. No bash.");
    expect((await inceptionStatus(paths)).changed).toEqual([]);
    await incept({ agentDir: dir, manual: true, loadRuntime: host.loadRuntime });
    expect(readFileSync(join(paths.workspace, "DIFF.md"), "utf8")).toContain("(no change");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
}, 20000);

test("headless inception cannot read live owner files, credentials, or modify live inputs and staged copies, and leaves the host's sandbox policy alone", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  const script = join(dir, "probe.ts");
  writeFileSync(join(dir, ".env"), "TEST_KEY=private");
  writeFileSync(script, `
    import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
    const live = ${JSON.stringify([paths.grant, join(dir, "manifest.md"), join(dir, ".env")])};
    for (const file of live) {
      let readable = false;
      try { readFileSync(file); readable = true; } catch {}
      if (readable) throw new Error('live input readable: ' + file);
    }
    for (const file of [...live, 'endograph.toml', 'manifest.md', '.endo/workspace/MANIFEST.md']) {
      for (const action of [() => writeFileSync(file, 'changed'), () => unlinkSync(file)]) {
        let writable = false;
        try { action(); writable = true; } catch {}
        if (writable) throw new Error('owner input writable: ' + file);
      }
    }
    if (!readFileSync('manifest.md', 'utf8').includes('Answer questions')) throw new Error('missing copy');
    if (process.env.TEST_KEY !== undefined) throw new Error('credential inherited from .env');
    writeFileSync('.endo/src/probe.txt', 'candidate writable');
  `);
  try {
    // The host's policy belongs to its running worker: its proxy applies changes to that worker live.
    const hostPolicy = SandboxManager.getConfig();
    process.env.TEST_KEY = "private"; // as the host's loadEnv leaves it
    await incept({ agentDir: dir, inceptor: `${process.execPath} ${script}` });
    expect(SandboxManager.getConfig()).toBe(hostPolicy);
    expect(readFileSync(join(paths.src, "probe.txt"), "utf8")).toBe("candidate writable");
    expect(readFileSync(join(dir, "manifest.md"), "utf8")).toBe("Answer questions.");
  } finally { delete process.env.TEST_KEY; rmSync(dir, { recursive: true, force: true }); }
});

test("a headless inceptor cannot create a missing .env for the host to load", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  try {
    const { argv } = protectInceptor(paths, await loadGrant(paths), dir, ["/bin/sh", "-c", `echo KEY=planted > ${JSON.stringify(paths.env)}`]);
    const child = Bun.spawn(argv, { cwd: dir, stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).not.toBe(0);
    expect(existsSync(paths.env) ? readFileSync(paths.env, "utf8") : "").toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["inline", "relocated"])("interactive %s manifests publish the exact validated input", async (kind) => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  try {
    await incept({ agentDir: dir, interactive: async ({ directory }) => {
      const config = readFileSync(paths.grant, "utf8");
      writeFileSync(pathsOf(directory).grant, kind === "inline"
        ? config + '\n[manifest]\ntext="Inline revised mandate"\n'
        : 'manifest="mandates/dev.md"\n' + config);
      writeFileSync(join(directory, "manifest.md"), "Relocated revised mandate");
    } });
    const text = kind === "inline" ? "Inline revised mandate" : "Relocated revised mandate";
    expect((await loadGrant(paths)).manifest.text).toBe(text);
    expect(readFileSync(join(paths.snapshots, "1/manifest.md"), "utf8")).toBe(text);
    expect((await inceptionStatus(paths)).changed).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("relocating the manifest during interactive inception never overwrites an existing owner file", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  writeFileSync(join(dir, "notes.md"), "owner notes");
  writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
  const attempts = ["notes.md", ".env"];
  const errors: string[] = [];
  try {
    await incept({ agentDir: dir, interactive: async ({ directory }) => {
      const staged = pathsOf(directory);
      if (existsSync(join(staged.workspace, "ERRORS.md"))) errors.push(readFileSync(join(staged.workspace, "ERRORS.md"), "utf8"));
      const config = readFileSync(paths.grant, "utf8");
      const target = attempts.shift();
      writeFileSync(staged.grant, target ? `manifest=${JSON.stringify(target)}\n` + config : config);
    } });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("would overwrite an existing file");
    expect(errors[1]).toContain("separate from endograph.toml, .env");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("owner notes");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TOKEN=secret\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validation enforces a sandbox requested during interactive inception before publishing it", async () => {
  const dir = realpathSync(scaffold());
  const outside = mkdtempSync(join(tmpdir(), "endo-owner-private-"));
  const secret = join(outside, "private.txt");
  writeFileSync(secret, "private");
  const paths = pathsOf(dir);
  const host = await createAgentHost({ agentDir: dir });
  let rounds = 0;
  try {
    await incept({ agentDir: dir, loadRuntime: host.loadRuntime, interactive: async ({ directory }) => {
      const candidate = pathsOf(directory);
      if (++rounds === 1) {
        writeFileSync(candidate.grant, readFileSync(paths.grant, "utf8") + '\n[sandbox]\nnetwork="offline"\n');
        writeFileSync(candidate.program, program + `\nimport { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(secret)});\n`);
      } else {
        expect(readFileSync(join(candidate.workspace, "ERRORS.md"), "utf8")).toMatch(/EPERM|EACCES|not permitted|denied/);
        expect((await loadGrant(paths)).sandbox).toBeUndefined();
        writeFileSync(candidate.program, program);
      }
    } });
    expect(rounds).toBe(2);
    expect((await loadGrant(paths)).sandbox?.network).toBe("offline");
    expect((await inceptionStatus(paths)).changed).toEqual([]);
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
}, 20000);
