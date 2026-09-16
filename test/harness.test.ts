import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createToolActionRequest,
  executeActionInvocation,
  type ExecuteActionResult,
  type ExecutorRunRequest,
  type ProjectorExecutor,
} from "@projectors/core";
import { HeldElsewhere, openAgent, type Agent } from "../src/harness/agent.ts";
import { LoadError } from "../src/program/load.ts";
import { loadFailure } from "../src/harness/inspect.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { adopt } from "../src/harness/residence.ts";
import { newId, PROTOCOL_VERSION, readReply, waitForReply, writeMessage } from "../src/protocol/wire.ts";
import { answer, scripted } from "./fixtures/agent/scripted.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { allFrames } from "../src/store/types.ts";

export const ROOT = resolve(import.meta.dir, "..");

/**
 * A fresh agent directory from the fixtures: the grant and manifest, and
 * unless told otherwise the program and three procedures under `.endo/`.
 * Nothing is rewritten: `endo` links endograph into `.endo/node_modules`
 * and everything resolves upward to it. The fixture executor sits beside
 * the grant's copy under `.endo/`; its projector import is the one thing
 * a test fixture needs that an agent never does.
 */
export function scaffold(opts: { program?: boolean; procedures?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "endo-agent-"));
  cpSync(join(ROOT, "test/fixtures/agent"), dir, { recursive: true });
  mkdirSync(join(dir, ".endo"), { recursive: true });
  writeFileSync(join(dir, ".endo/scripted.ts"), readFileSync(join(dir, "scripted.ts"), "utf8").replaceAll('"@projectors/core"', `"${import.meta.resolve("@projectors/core")}"`));
  rmSync(join(dir, "scripted.ts"));
  if (opts.program !== false) {
    mkdirSync(join(dir, ".endo/program"), { recursive: true });
    cpSync(join(ROOT, "test/fixtures/program.ts"), join(dir, ".endo/program/agent.ts"));
  }
  if (opts.procedures !== false) {
    mkdirSync(join(dir, ".endo/src/procedures"), { recursive: true });
    for (const p of ["hello", "ask", "broken", "nightly"]) cpSync(join(ROOT, `test/fixtures/procedures/${p}.ts`), join(dir, `.endo/src/procedures/${p}.ts`));
  }
  return dir;
}

const send = (agent: Agent, text: string, id = newId()) => (writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id, text, at: Date.now() }), id);
const callProc = (agent: Agent, procedure: string, args: Record<string, unknown> = {}, id = newId()) =>
  (writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "call", id, procedure, args, at: Date.now() }), id);
const wait = (agent: Agent, id: string, terminal = true) => waitForReply(agent.paths.outbox, id, { timeoutMs: 15000, pollMs: 25, terminal });

test("calls, requests, procedures that emit, reply-once, live reload, and recovery after a restart", async () => {
  const dir = scaffold();
  const log: string[] = [];
  let agent = await openAgent({ agentDir: dir, executor: scripted(answer), pollMs: 50, activationTimeoutMs: 800, log: (l) => log.push(l) });
  expect(agent.loaded.procedures.map((p) => p.name)).toEqual(["ask", "hello", "nightly"]);
  expect(agent.loaded.failures.map((f) => f.name)).toEqual(["broken"]);
  agent.start();
  try {
    // A call runs its procedure without the model; unknown names and bad args are rejected deterministically.
    expect((await wait(agent, callProc(agent, "hello", { NAME: "x" })))?.text).toBe("hello x");
    expect(await wait(agent, callProc(agent, "nope"))).toMatchObject({ state: "rejected", text: expect.stringMatching(/exposed: ask, hello/) });
    expect(await wait(agent, callProc(agent, "hello", {}))).toMatchObject({ state: "rejected", text: expect.stringMatching(/invalid args/) });

    // A request wakes the model; here it runs a procedure as a tool and answers with the result.
    expect((await wait(agent, send(agent, "say hello")))?.text).toBe("hello bob");
    expect((await wait(agent, send(agent, "note this please")))?.text).toBe("seen from local:" + (process.env.USER ?? ""));

    // A request the program never answers is failed by the harness when the activation ends; a hang is aborted.
    expect(await wait(agent, send(agent, "ignore me"))).toMatchObject({ ok: false, state: "failed", text: expect.stringMatching(/ended without a reply/) });
    expect(await wait(agent, send(agent, "hang"))).toMatchObject({ ok: false, state: "failed", text: expect.stringMatching(/timed out/) });

    // A procedure acks, emits a message to its agent (stamped as the procedure), waits for the answer, and completes.
    const ask = callProc(agent, "ask");
    expect(await wait(agent, ask, false)).toMatchObject({ state: "working", text: "asking" });
    expect(await wait(agent, ask)).toMatchObject({ ok: true, state: "completed", text: "agent said: 4" });

    // evolve: a spawn naming an unknown tool is refused with the granted names; the retry lands as an instance frame.
    expect((await wait(agent, send(agent, "spawn a helper")))?.text).toMatch(/unknown tools: nope; granted: .*bash/);
    expect(agent.loaded.machine.instance.children?.map((c) => c.node.key)).toEqual(["helper"]);

    // scheduler: a tick starts the due procedure as a timer call.
    await agent.tick(Date.now());
    for (let i = 0; i < 100 && agent.runs.active().length; i++) await Bun.sleep(50);

    // A message from another agent's live run is stamped as that agent's procedure, checked through the registry.
    process.env.ENDOGRAPH_HOME = mkdtempSync(join(tmpdir(), "endo-home-"));
    const other = mkdtempSync(join(tmpdir(), "endo-other-"));
    writeFileSync(join(other, "endograph.toml"), 'name = "other"\n[executor]\nprovider = "openai"\nmodel = "x"\n');
    mkdirSync(join(other, ".endo/runs"), { recursive: true });
    writeFileSync(join(other, ".endo/runs/r9.json"), JSON.stringify({ id: "r9", procedure: "deploy" }));
    (await import("../src/cli/registry.ts")).claim("other", other);
    writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id: "from-other", text: "2+2?", run: "r9", agent: "other", at: Date.now() });
    expect((await wait(agent, "from-other"))?.text).toBe("4");
    writeMessage(agent.paths.inbox, { v: PROTOCOL_VERSION, kind: "request", id: "from-dead", text: "who am i", run: "gone", agent: "other", at: Date.now() });
    expect((await wait(agent, "from-dead"))?.text).toMatch(/^seen from local:/);

    // A duplicate id is dropped; a second terminal reply is refused.
    const first = send(agent, "2+2?");
    expect((await wait(agent, first))?.text).toBe("4");
    send(agent, "2+2 again", first);
    await agent.poll();
    expect(readReply(agent.paths.outbox, first)?.text).toBe("4");
    expect(agent.reply(first, { ok: true, state: "completed", text: "again" })).toMatch(/no open request/);

    // A new procedure file is picked up between activations.
    writeFileSync(join(dir, ".endo/src/procedures/bye.ts"), readFileSync(join(ROOT, "test/fixtures/procedures/hello.ts"), "utf8").replaceAll("hello", "bye"));
    for (let i = 0; i < 100 && !agent.loaded.procedures.some((p) => p.name === "bye"); i++) await Bun.sleep(50);
    expect((await wait(agent, callProc(agent, "bye", { NAME: "now" })))?.text).toBe("bye now");
  } finally {
    await agent.stop();
  }
  expect(log.find((l) => l.includes("request"))).toMatch(/^ *\d+  \d\d:\d\d:\d\d  request     [\w-]+  local:/);

  const store = openSqliteStore(join(dir, ".endo/agent.db"));
  const frames = [...allFrames(store)];
  const emitted = frames.find((f) => f.type === "request" && f.summary.includes("2+2?") && f.summary.startsWith("agent:"));
  expect(emitted?.summary).toBe("agent:fixture/ask: what is 2+2?");
  expect(frames.find((f) => f.type === "procedure")?.summary).toMatch(/broken failed to describe/);
  expect(frames.find((f) => f.type === "call" && f.summary.startsWith("timer:"))?.summary).toBe("timer:nightly: nightly");
  expect(frames.find((f) => f.type === "request" && f.id === "from-other")?.summary).toBe("agent:other/deploy: 2+2?");
  expect(existsSync(join(dir, ".endo/tsconfig.json"))).toBe(true);
  expect(readFileSync(join(dir, ".endo/.gitignore"), "utf8")).toMatch(/^node_modules$/m);
  expect(frames.filter((f) => f.type === "reply").map((f) => (f.payload as { text: string }).text)).toContain("checked");
  expect(frames.filter((f) => f.type === "request" && f.summary.includes("2+2 again"))).toEqual([]);
  // Simulate a crash: a request frame whose activation never completed, and one whose activation completed without a reply.
  const lost = (id: string, completed: boolean) => ({
    type: "request",
    summary: `local:t: ${id}`,
    id,
    at: Date.now(),
    payload: {
      id: `frame-${id}`,
      messages: [
        { type: "user", text: `[request id=${id} from=local:t]\n2+2?`, actor: { id: "local:t", label: "local:t" } },
        // What the machine appends at enqueue: the scheduled activation. A crash leaves it without a completion.
        { type: "work", kind: "activation", activationId: `activation:${id}`, generatorId: "instance:agent", sourceFrameId: `frame-${id}`, concurrencyKey: "instance:agent", concurrency: "serial" },
        ...(completed ? [{ type: "work", kind: "completion", activationId: `activation:${id}`, generatorId: "instance:agent", sourceFrameId: `frame-${id}`, reason: "end-turn" }] : []),
      ],
      metadata: { endo: { type: "request", summary: id, id, ids: [id], at: Date.now(), requests: [{ v: 1, kind: "request", id, from: "local:t", text: "2+2?", at: 1 }] } },
    },
  });
  store.append(lost("lost-live", false));
  store.append(lost("lost-done", true));
  store.close();

  agent = await openAgent({ agentDir: dir, executor: scripted(answer), pollMs: 50 });
  try {
    expect(readReply(agent.paths.outbox, "lost-done")).toMatchObject({ state: "failed", text: expect.stringMatching(/restarted/) });
    expect((await wait(agent, "lost-live"))?.text).toBe("4");
    expect(agent.status().open).toEqual([]);
  } finally {
    await agent.stop();
  }
}, 30000);

test("residence: one host runs a state directory; a copy elsewhere refuses until adopted, and the holder stops when adopted", async () => {
  const dir = scaffold();
  const status = join(dir, ".endo/status.json");
  const read = () => JSON.parse(readFileSync(status, "utf8"));
  let adoptedBy: string | undefined;
  let agent = await openAgent({ agentDir: dir, executor: scripted(answer), pollMs: 50, onAdopted: (h) => (adoptedBy = h) });
  agent.start();
  expect(read()).toMatchObject({ host: hostname(), running: true });
  // Another host's newer status lands (a synced mirror): the agent records the move, stops writing, and asks to be stopped.
  writeFileSync(status, JSON.stringify({ ...read(), host: "elsewhere", at: Date.now() + 1 }));
  for (let i = 0; i < 100 && !adoptedBy; i++) await Bun.sleep(50);
  expect(adoptedBy).toBe("elsewhere");
  await agent.stop();
  expect(read().host).toBe("elsewhere");
  // This host now refuses; adopting records the move and restamps the status, released.
  await expect(openAgent({ agentDir: dir, executor: scripted(answer) })).rejects.toBeInstanceOf(HeldElsewhere);
  expect(adopt(pathsOf(dir))?.host).toBe("elsewhere");
  agent = await openAgent({ agentDir: dir, executor: scripted(answer), pollMs: 50 });
  await agent.stop();
  expect(read()).toMatchObject({ host: hostname(), running: false });
  const store = openSqliteStore(join(dir, ".endo/agent.db"));
  expect([...allFrames(store)].filter((f) => f.type === "residence").map((f) => f.summary)).toEqual([expect.stringMatching(/^adopted by elsewhere/), expect.stringMatching(/^adopted from elsewhere/)]);
  store.close();
});

test("a program that does not load is recorded as a frame and in status.json; the record dies with the program that failed", async () => {
  const dir = scaffold();
  const paths = pathsOf(dir);
  writeFileSync(paths.program, "throw new Error('boom');\n");
  await expect(openAgent({ agentDir: dir, executor: scripted(answer) })).rejects.toBeInstanceOf(LoadError);

  const status = JSON.parse(readFileSync(paths.status, "utf8"));
  expect(status.running).toBe(false);
  expect(status.failure.stage).toBe("program");
  expect(status.failure.error).toContain("boom");
  expect(loadFailure(paths)?.stage).toBe("program");
  const store = openSqliteStore(paths.db);
  const frames = [...allFrames(store)];
  store.close();
  expect(frames.some((f) => f.type === "error" && f.summary.startsWith("program does not load at program:"))).toBe(true);
  expect((await import("../src/harness/lock.ts")).isLocked(paths.lock)).toBe(false);

  // The program changes (an inception wrote a new one): the record no longer applies.
  await Bun.sleep(5);
  writeFileSync(paths.program, readFileSync(join(ROOT, "test/fixtures/program.ts"), "utf8"));
  expect(loadFailure(paths)).toBeNull();

  // A load that succeeds rewrites the status without the record. A second directory: once a module has thrown
  // at import, bun hands back an empty namespace for that path for the rest of the process (the harness never
  // loads twice in one process; a load failure exits it).
  const dir2 = scaffold();
  const paths2 = pathsOf(dir2);
  const { hashOf } = await import("../src/inception/incept.ts");
  writeFileSync(paths2.status, JSON.stringify({ host: hostname(), running: false, at: Date.now(), failure: { stage: "invoke", error: "old", program: hashOf(paths2.program), at: Date.now() } }));
  expect(loadFailure(paths2)?.stage).toBe("invoke");
  const agent = await openAgent({ agentDir: dir2, executor: scripted(answer), pollMs: 50 });
  expect(JSON.parse(readFileSync(paths2.status, "utf8")).failure).toBeUndefined();
  expect(loadFailure(paths2)).toBeNull();
  await agent.stop();
});

test("a thread request queued by a client is served once and stays in that discussion after restart", async () => {
  const { agentQuery } = await import("../src/client.ts");
  const dir = scaffold({ procedures: false });
  let agent: Agent | undefined;
  try {
    await agentQuery(dir, { op: "threads.create", id: "discussion", title: "Arithmetic" });
    const request = { op: "messages.send", id: newId(), threadId: "discussion", text: "2+2?" };
    await agentQuery(dir, request);
    agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    await agent.poll();
    expect(readReply(agent.paths.outbox, request.id)).toMatchObject({ ok: true, text: "4" });
    await agent.stop(); agent = undefined;
    await agentQuery(dir, request);
    agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    await agent.poll();
    const page = await agentQuery(dir, { op: "messages.list", threadId: "discussion" }) as any;
    expect(page.messages.map((m: any) => m.kind)).toEqual(["request", "reply"]);
    expect(page.messages[1]).toMatchObject({ threadId: "discussion", text: "4" });
    expect(JSON.stringify([...allFrames(agent.store)])).toContain("thread=discussion");
  } finally { await agent?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
