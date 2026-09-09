import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createAgentHost } from "../src/host/agent.ts";
import { hostAction } from "../src/host/action.ts";
import { incept, validateProgram } from "../src/inception/incept.ts";
import { archivePath, commitNumbers, readCommit } from "../src/store/archive.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { newId, readReply, writeMessage } from "../src/protocol/wire.ts";

const root = resolve(import.meta.dir, "..");
const program = `// .endo/program/agent.ts — written by inception 1 (2026-09-04). Do not edit:
// change manifest.md or endograph.toml and run \`endo incept\`.
import { createNode, createSourceInstance, defineProgram, tool } from "endograph";
if (process.pid === ${process.pid}) throw new Error("parent imported generated program");
export default defineProgram((endo) => {
  const node = createNode({key:"test",instructions:"reply",parts:Object.values(endo.actions).map(a=>tool(a)),runtime:{type:"generator",trigger:{type:"actor-frame"}}});
  return {nodes:[node],instance:createSourceInstance({id:"agent",node})};
});
`;

test.each(['provider="openai"\nmodel="fixture"', 'backend="codex"'])("validation permits schemas but denies direct host and model IPC (%s)", async (executor) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "endo-validation-")));
  const paths = pathsOf(dir);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  writeFileSync(paths.grant, `name="validation-test"\nhost_actions=["effect"]\n[executor]\n${executor}\n`);
  writeFileSync(join(dir, "manifest.md"), "Validation must not execute host effects.");
  // Send raw protocol messages during module import, bypassing worker proxies.
  const probe = `
const replies = [];
for (const request of [{kind:"describe"}, {kind:"call",name:"effect",args:{}}, {kind:"model",args:{}}]) {
  const id = crypto.randomUUID();
  replies.push(await new Promise(resolve => {
    const listener = raw => {
      const reply = JSON.parse(raw);
      if (reply.id === id) { process.off("message", listener); resolve(reply); }
    };
    process.on("message", listener);
    process.send(JSON.stringify({v:1,id,...request}));
  }));
}
await Bun.write(${JSON.stringify(join(paths.state, "probe.json"))}, JSON.stringify(replies));
`;
  let effects = 0;
  const host = await createAgentHost({ agentDir: dir, actions: [hostAction({
    name: "effect", description: "count an external effect", inputSchema: z.object({}),
    run() { effects++; return null; },
  })] });
  try {
    for (const fail of [false, true]) {
      const lines = program.split("\n");
      lines.splice(2, 0, probe, ...(fail ? ['throw new Error("deliberately rejected candidate");'] : []));
      writeFileSync(paths.program, lines.join("\n"));
      const result = await validateProgram({ paths, grant: await host.grant(), loadRuntime: host.loadRuntime });
      expect(result.ok).toBe(!fail);
      if (!result.ok) expect(result.error).toContain("deliberately rejected candidate");
      const replies = JSON.parse(readFileSync(join(paths.state, "probe.json"), "utf8"));
      expect(replies[0]).toMatchObject({ ok: true, value: [expect.objectContaining({ name: "effect", inputSchema: expect.any(Object) })] });
      for (const reply of replies.slice(1)) expect(reply).toMatchObject({ ok: false, error: { code: "denied", message: "host execution is unavailable during validation" } });
      expect(effects).toBe(0);
    }
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function until<T>(fn: () => T | undefined, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = fn(); if (value !== undefined) return value; } catch {}
    await Bun.sleep(20);
  }
  throw new Error("hosted agent did not reach expected state");
}

test("hosted runtime revokes cached actions and cold restarts even when postcommit inception finalization fails", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "endo-host-agent-")));
  const paths = pathsOf(dir);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  writeFileSync(paths.program, program);
  writeFileSync(join(dir, "manifest.md"), "Use the host action and reply.");
  const grant = (names: string[]) => `name="host-test"\nhost_modules=[".endo/host.ts"]\nhost_actions=${JSON.stringify(names)}\n[executor]\nmodule=".endo/executor.ts"\n`;
  writeFileSync(paths.grant, grant(["sentryApi"]));
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(root, "test/fixtures/agent/scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  writeFileSync(join(paths.state, "executor.ts"), `
    import {scripted} from "./scripted.ts";
    if(process.pid===${process.pid})throw new Error("parent imported custom executor");
    export default {description:"test",create:()=>scripted(async turn=>{
      for(const r of turn.requests){
        if(r.text==="double") {
          await turn.call("sentryApi",{});
          const result=await turn.call("sentryApi",{});
          await turn.call("reply",{id:r.id,ok:true,text:result.success?"unexpected success":result.error});
        } else await turn.call("reply",{id:r.id,ok:true,text:"alive pid="+process.pid});
      }
    })};
  `);
  writeFileSync(join(paths.state, "host.ts"), `
    import {hostAction,z} from "endograph";
    if(process.pid!==${process.pid})throw new Error("worker imported trusted host module");
    export default hostAction({name:"parentOnly",description:"trusted module",inputSchema:z.object({}),run:()=>true});
  `);
  let release!: () => void;
  let started!: () => void;
  const called = new Promise<void>((r) => started = r);
  const hold = new Promise<void>((r) => release = r);
  let calls = 0;
  const inceptor = join(dir, "inceptor.ts");
  const failedRecord = join(paths.inceptions, "3/inception.json");
  writeFileSync(inceptor, `
    import {existsSync,mkdirSync,rmSync} from "node:fs";
    // The record is opened before the inceptor runs. Its metadata is next
    // touched after promotion, when closing the completed inception record.
    const file=${JSON.stringify(failedRecord)};
    if(existsSync(file)){rmSync(file);mkdirSync(file);}
  `);
  const host = await createAgentHost({ agentDir: dir, inceptor: `${process.execPath} ${inceptor}`, log: () => { throw new Error("log observer unavailable"); }, actions: [hostAction({ name: "sentryApi", description: "read issue", inputSchema: z.object({}).strict(), async run() { calls++; started(); await hold; return "first response"; } })] });
  let running: Promise<number> | undefined;
  try {
    await incept({ agentDir: dir, inceptor: "true", loadRuntime: host.loadRuntime });
    const catalogueAt = statSync(join(paths.state, "host-actions.json")).mtimeMs;
    writeFileSync(join(dir, "manifest.md"), "Owner changed the manifest while the agent was stopped.");
    running = host.run();
    await until(() => {
      const meta = JSON.parse(readFileSync(join(paths.inceptions, "2/inception.json"), "utf8"));
      return meta.outcome === "recorded" ? true : undefined;
    });
    await until(() => JSON.parse(readFileSync(paths.status, "utf8")).running ? true : undefined);
    const before = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id: before, text: "ping", at: Date.now() });
    const initial = await until(() => readReply(paths.outbox, before) ?? undefined);
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text: "double", at: Date.now() });
    await called;
    writeFileSync(paths.grant, grant([]));
    release();
    expect((await until(() => readReply(paths.outbox, id) ?? undefined)).text).toBe("host action is not granted");
    expect(calls).toBe(1);
    // Registry validation happens on each call, but unchanged descriptors are not rewritten.
    expect(statSync(join(paths.state, "host-actions.json")).mtimeMs).toBe(catalogueAt);
    await until(() => {
      const archive = archivePath(paths.db);
      return commitNumbers(archive).some((n) => readCommit(archive, n).frames.some((frame) => frame.type === "inception" && (frame.payload as { n: number }).n === 3)) ? true : undefined;
    });
    expect(statSync(failedRecord).isDirectory()).toBe(true);
    const after = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id: after, text: "ping", at: Date.now() });
    const final = await until(() => readReply(paths.outbox, after) ?? undefined);
    expect(final.text).toStartWith("alive pid=");
    expect(final.text).not.toBe(initial.text);
  } finally {
    release(); await host.close(); if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("a failed startup inception consumes its owner fingerprint, including direct worker retries", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "endo-host-retry-")));
  const paths = pathsOf(dir);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  writeFileSync(paths.grant, 'name="retry-test"\n[executor]\nprovider="openai"\nmodel="unused"\n');
  writeFileSync(join(dir, "manifest.md"), "Original owner intent.");
  const trigger = join(paths.state, "retry-trigger");
  const resultFile = join(paths.state, "retry-result.json");
  const attempts = join(paths.state, "attempts");
  const inceptor = join(dir, "fail-inception.ts");
  writeFileSync(inceptor, `import {existsSync,readFileSync,writeFileSync} from "node:fs";
    const file=${JSON.stringify(attempts)};
    writeFileSync(file,String((existsSync(file)?Number(readFileSync(file,"utf8")):0)+1));
    process.exit(1);
  `);
  // The program sends an RPC directly after the harness's ordinary failed attempt.
  writeFileSync(paths.program, program + `
    import {existsSync,unlinkSync,writeFileSync} from "node:fs";
    if(process.argv[2]==="run")process.on("message",raw=>{
      const response=JSON.parse(raw);
      if(response.error?.message==="host action failed")writeFileSync(${JSON.stringify(resultFile + ".first")},"replied");
    });
    if(process.argv[2]==="run")setInterval(()=>{
      if(!existsSync(${JSON.stringify(trigger)}))return;
      unlinkSync(${JSON.stringify(trigger)});
      const id=crypto.randomUUID();
      const receive=(raw)=>{
        const response=JSON.parse(raw);
        if(response.id!==id)return;
        process.off("message",receive);
        writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(response));
      };
      process.on("message",receive);
      process.send(JSON.stringify({v:1,id,kind:"call",name:"endoIncept",args:{}}));
    },20);
  `);
  const host = await createAgentHost({ agentDir: dir, inceptor: `${process.execPath} ${inceptor}`, log: () => {} });
  let running: Promise<number> | undefined;
  try {
    await incept({ agentDir: dir, inceptor: "true", loadRuntime: host.loadRuntime });
    writeFileSync(join(dir, "manifest.md"), "Owner changed intent while stopped.");
    running = host.run();
    await until(() => {
      const meta = JSON.parse(readFileSync(join(paths.inceptions, "2/inception.json"), "utf8"));
      return meta.outcome === "failed" ? true : undefined;
    });
    await until(() => readFileSync(resultFile + ".first", "utf8"));
    expect(readFileSync(attempts, "utf8")).toBe("1");
    writeFileSync(trigger, "retry");
    const result = await until(() => JSON.parse(readFileSync(resultFile, "utf8")));
    expect(result).toMatchObject({ ok: false, error: { message: "automatic inception is unavailable" } });
    expect(readFileSync(attempts, "utf8")).toBe("1");
  } finally {
    await host.close(); if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("a worker exits when its trusted parent dies", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "endo-host-parent-death-")));
  const paths = pathsOf(dir);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  mkdirSync(paths.inbox);
  writeFileSync(paths.program, program);
  writeFileSync(join(dir, "manifest.md"), "Report the worker process identity.");
  writeFileSync(paths.grant, 'name="parent-death"\n[executor]\nmodule=".endo/executor.ts"\n[inception]\nmode="manual"\n');
  writeFileSync(join(paths.state, "executor.ts"), `
    import {scripted} from ${JSON.stringify(join(root, "test/fixtures/agent/scripted.ts"))};
    export default {create:()=>scripted(async({requests,call})=>{
      for(const request of requests)await call("reply",{id:request.id,ok:true,text:String(process.pid)});
    })};
  `);
  const parentFile = join(dir, "parent.ts");
  writeFileSync(parentFile, `
    import {createAgentHost} from ${JSON.stringify(join(root, "src/host/agent.ts"))};
    const host=await createAgentHost({agentDir:${JSON.stringify(dir)}});
    process.exit(await host.run());
  `);
  const parent = Bun.spawn([process.execPath, parentFile], { stdout: "ignore", stderr: "pipe" });
  const errors = new Response(parent.stderr).text();
  let workerPid: number | undefined;
  const workerAlive = () => {
    if (!workerPid) return false;
    try { process.kill(workerPid, 0); return true; } catch { return false; }
  };
  try {
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text: "pid", at: Date.now() });
    workerPid = Number((await until(() => readReply(paths.outbox, id) ?? undefined)).text);
    expect(workerPid).toBeGreaterThan(0);
    expect(workerPid).not.toBe(parent.pid);
    expect(workerAlive()).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    await until(() => workerAlive() ? undefined : true, 5000);
    expect(await errors).toBe("");
  } finally {
    parent.kill("SIGTERM");
    await parent.exited;
    if (workerAlive()) process.kill(workerPid!, "SIGKILL");
    await errors;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
