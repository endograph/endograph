import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openAgent } from "../src/harness/agent.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { createRuns, type Run } from "../src/procedures/runs.ts";
import type { ProcedureSpec } from "../src/procedures/describe.ts";
import { newId, PROTOCOL_VERSION, readReply, waitForReply, writeMessage, writeReply, type Reply } from "../src/protocol/wire.ts";
import { scripted } from "./fixtures/agent/scripted.ts";

const ROOT = resolve(import.meta.dir, "..");
const spec = (file: string): ProcedureSpec => ({
  name: "example", file, description: "test", expose: true, args: {}, fields: {},
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

function scaffoldAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-model-run-"));
  cpSync(join(ROOT, "test/fixtures/agent"), dir, { recursive: true });
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/program.ts"), paths.program);
  writeFileSync(join(paths.state, "scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', JSON.stringify(import.meta.resolve("@projectors/core"))));
  return dir;
}

test("a procedure acknowledgement resolves first while its terminal promise stays pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-runs-"));
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  const release = join(paths.state, "release");
  const file = join(paths.procedures, "example.ts");
  writeFileSync(file, `
import { existsSync } from "node:fs";
import { procedure, actionResult } from "endograph/procedure";
await procedure({ description: "ack before exit" });
actionResult("accepted");
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
console.log("finished");
`);
  const replies: Reply[] = [];
  const runs = createRuns({ paths, name: "test", cwd: dir, onReply(run, reply) {
    // The callback can commit before publishing and before recovery data
    // disappears. In particular, a procedure never publishes its own ack.
    expect(existsSync(join(paths.runs, `${run.id}.json`))).toBe(true);
    expect(readReply(paths.outbox, run.id)?.state).toBe(reply.state === "working" ? undefined : "working");
    replies.push(reply);
    writeReply(paths.outbox, reply);
    return reply;
  } });
  // The largest valid wire ID must also work as a run and acknowledgement ID.
  const run = runs.start({ procedure: spec(file), args: {}, id: "r".repeat(124) + ".ack" });
  let terminal = false;
  void run.terminal.then(() => { terminal = true; });
  try {
    expect(await Promise.race([run.first, Bun.sleep(3000).then(() => null)])).toMatchObject({ state: "working", text: "accepted" });
    expect(terminal).toBe(false);
    expect(runs.get(run.id)).toBe(run);
  } finally {
    writeFileSync(release, "");
    await run.terminal;
    rmSync(dir, { recursive: true, force: true });
  }
  expect(replies.map((reply) => reply.state)).toEqual(["working", "completed"]);
  expect(runs.active()).toEqual([]);
});

test("without an acknowledgement, first resolves to the terminal reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-runs-"));
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  const file = join(paths.procedures, "example.ts");
  writeFileSync(file, 'console.error("broken"); process.exit(2);');
  const replies: Reply[] = [];
  const runs = createRuns({ paths, name: "test", cwd: dir, onReply: (_run, reply) => {
    replies.push(reply);
    writeReply(paths.outbox, reply);
    return reply;
  } });
  try {
    const run = runs.start({ procedure: spec(file), args: {} });
    expect(await run.first).toBe(await run.terminal);
    expect(await run.first).toMatchObject({ state: "failed", text: "broken\nexample exited 2" });
    await Bun.sleep(150);
    expect(replies.map((reply) => reply.state)).toEqual(["failed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model tool call can acknowledge, message its own agent, await its answer, and complete", async () => {
  const dir = scaffoldAgent();
  const paths = pathsOf(dir);
  writeFileSync(join(paths.procedures, "ask.ts"), readFileSync(join(ROOT, "test/fixtures/procedures/ask.ts"), "utf8").replace("20000", "3000"));
  let procedureRun: Run | undefined;
  let result: unknown;
  const agent = await openAgent({ agentDir: dir, pollMs: 25, activationTimeoutMs: 5000, executor: scripted(async (turn) => {
    for (const request of turn.requests) {
      if (request.text === "start the procedure") {
        const action = await turn.call("ask", {});
        result = action;
        procedureRun = agent.runs.active().find((run) => run.procedure === "ask");
        await turn.call("reply", { id: request.id, ok: action.success, text: action.success ? String(action.value) : String(action.error) });
      } else {
        await turn.call("reply", { id: request.id, ok: true, text: "4" });
      }
    }
  }) });
  agent.start();
  try {
    const id = newId();
    writeMessage(paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text: "start the procedure", at: Date.now() });
    expect(await waitForReply(paths.outbox, id, { timeoutMs: 7000, pollMs: 25, terminal: true })).toMatchObject({ state: "completed", text: "asking" });
    expect(result).toMatchObject({ success: true, value: "asking" });
    expect(procedureRun).toBeDefined();
    expect(await procedureRun!.terminal).toMatchObject({ state: "completed", text: "agent said: 4" });
    expect(agent.runs.active()).toEqual([]);
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("stopping detaches a live run so a new harness can recover and publish its completion", async () => {
  const dir = scaffoldAgent();
  const paths = pathsOf(dir);
  const release = join(paths.state, "release");
  writeFileSync(join(paths.procedures, "wait.ts"), `
import { existsSync } from "node:fs";
import { procedure, actionResult } from "endograph/procedure";
await procedure({ description: "wait for release", expose: true });
actionResult("waiting");
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
console.log("resumed");
`);
  const executor = scripted(async () => {});
  let agent = await openAgent({ agentDir: dir, executor });
  const id = "resume.ack";
  try {
    writeMessage(paths.inbox, { v: PROTOCOL_VERSION, kind: "call", id, procedure: "wait", args: {}, at: Date.now() });
    await agent.poll();
    expect(await waitForReply(paths.outbox, id, { timeoutMs: 3000, pollMs: 25 })).toMatchObject({ state: "working", text: "waiting" });
    const previous = agent.runs.get(id)!;
    let oldSettled = false;
    void previous.terminal.then(() => { oldSettled = true; });
    await agent.stop();
    // The old harness must leave the process and its recovery record alone.
    expect(existsSync(join(paths.runs, `${id}.json`))).toBe(true);
    expect(existsSync(join(paths.runs, "acks", `${id}.json`))).toBe(true);
    agent = await openAgent({ agentDir: dir, executor });
    const adopted = agent.runs.get(id);
    expect(adopted).toBeDefined();
    writeFileSync(release, "");
    expect(await adopted!.terminal).toMatchObject({ state: "completed", text: "resumed" });
    await Bun.sleep(150);
    expect(oldSettled).toBe(false);
    expect(readReply(paths.outbox, id)).toMatchObject({ state: "completed", text: "resumed" });
    expect(existsSync(join(paths.runs, `${id}.json`))).toBe(false);
    expect(existsSync(join(paths.runs, "acks", `${id}.json`))).toBe(false);
  } finally {
    writeFileSync(release, "");
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
