import { expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAgent } from "../src/harness/agent.ts";
import { isMessage, readReply, writeMessage, waitForReply } from "../src/protocol/wire.ts";
import { allFrames } from "../src/store/types.ts";
import { createServer } from "../packages/server/src/index.ts";
import { scaffold } from "./harness.test.ts";
import { answer, scripted } from "./fixtures/agent/scripted.ts";

test("trusted authorship, caller context, notifications and reply recipients survive archive recovery", async () => {
  const dir = scaffold();
  const procedure = join(dir, ".endo/src/procedures/notify.ts");
  writeFileSync(procedure, `
import { procedure, caller, actionResult, emitMessage, waitForCompletion } from "endograph/procedure";
await procedure({ description: "notify caller", expose: true });
const context = caller();
actionResult("working for " + context.from);
const receipt = emitMessage({ to: context.from, text: "notification" });
const pending = emitMessage({ to: "agent:unregistered-destination", text: "pending" });
if (!pending.notification) throw new Error("unregistered destination must remain pending");
const local = emitMessage({ to: "agent:fixture", text: "2+2?" });
console.log(JSON.stringify({ context, receipt, answer: (await waitForCompletion(local)).text }));
`);
  let agent = await openAgent({ agentDir: dir, executor: scripted(answer), pollMs: 25 });
  const paths = agent.paths;
  agent.start();
  try {
    writeMessage(paths.inbox, { v: 1, kind: "call", id: "notify", from: "oidc:issuer#alice", procedure: "notify", args: {}, at: 1 });
    const terminal = await waitForReply(paths.outbox, "notify", { timeoutMs: 5000, pollMs: 25, terminal: true });
    expect(terminal).toMatchObject({ from: "agent:fixture", to: "oidc:issuer#alice", state: "completed" });
    const output = JSON.parse(terminal!.text);
    expect(output.context).toEqual({ id: "notify", from: "oidc:issuer#alice" });
    expect(output.answer).toBe("4");
    const notificationPath = join(paths.outbox, "messages", `${output.receipt.id}.json`);
    expect(JSON.parse(readFileSync(notificationPath, "utf8"))).toMatchObject({
      from: "agent:fixture/notify", to: "oidc:issuer#alice", cause: "notify", kind: "notification", text: "notification",
    });
    writeMessage(paths.inbox, { v: 1, kind: "call", id: "notify", from: "oidc:issuer#bob", procedure: "notify", args: {}, at: 2 });
    await agent.poll();
    expect(readReply(paths.outbox, "notify")).toEqual(terminal);
    writeMessage(paths.inbox, { v: 1, kind: "request", id: "wrong-target", from: "local:alice", to: "agent:elsewhere", text: "2+2?", at: 3 });
    await agent.poll();
    expect(readReply(paths.outbox, "wrong-target")).toMatchObject({ to: "local:alice", state: "rejected" });
    const count = [...allFrames(agent.store)].filter((frame) => frame.type === "notification").length;
    expect(count).toBe(2);
    await agent.stop();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(paths.db + suffix, { force: true });
    rmSync(paths.outbox, { recursive: true });
    agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
    expect(readReply(paths.outbox, "notify")).toEqual(terminal);
    expect(JSON.parse(readFileSync(notificationPath, "utf8"))).toMatchObject({ to: "oidc:issuer#alice", cause: "notify" });
    await agent.poll();
    expect([...allFrames(agent.store)].filter((frame) => frame.type === "notification")).toHaveLength(2);
  } finally { await agent.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("relay isolates callers, refuses identity overrides, and exposes only addressed output", async () => {
  const dir = scaffold();
  const agent = await openAgent({ agentDir: dir, executor: scripted(answer) });
  // A fixture authenticator; production adapters must verify their credentials.
  const fetch = createServer({ agents: { fixture: agent.paths.state }, authenticate: (request) => {
    const token = request.headers.get("authorization");
    return token === "Bearer alice" ? "token:alice" : token === "Bearer bob" ? "token:bob" : null;
  }, maxBodyBytes: 1024 });
  const request = (user: string, path: string, body?: unknown) => fetch(new Request(`http://relay/agents/fixture/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${user}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    expect((await request("nobody", "messages")).status).toBe(401);
    for (const field of ["from", "to", "run", "agent", "cause"]) {
      expect((await request("alice", "messages", { text: "2+2?", [field]: "token:bob" })).status).toBe(400);
    }
    expect((await request("alice", "messages", { text: "x".repeat(2048) })).status).toBe(413);
    for (const user of ["alice", "bob"]) expect((await request(user, "messages", { id: "same", text: "who am i", ref: "thread" })).status).toBe(202);
    const queued = readdirSync(agent.paths.inbox).map((file) => JSON.parse(readFileSync(join(agent.paths.inbox, file), "utf8")));
    expect(new Set(queued.map((message) => message.id)).size).toBe(2);
    expect(new Set(queued.map((message) => message.ref)).size).toBe(2);
    await agent.poll();
    for (const user of ["alice", "bob"]) {
      const reply = await (await request(user, "replies/same")).json();
      expect(reply).toMatchObject({ id: "same", to: `token:${user}` });
    }
    await request("alice", "messages", { id: "private", kind: "call", procedure: "hello", args: { NAME: "Alice" } });
    await agent.poll();
    const run = agent.runs.active()[0]!;
    await run.terminal;
    expect((await request("alice", "replies/private")).status).toBe(200);
    expect((await request("bob", "replies/private")).status).toBe(404);
    writeMessage(agent.paths.inbox, { v: 1, kind: "request", id: "local-submission", from: "token:alice", text: "2+2?", at: 2 });
    await agent.poll();
    expect((await request("alice", "replies/local-submission")).status).toBe(200);
    expect((await request("bob", "replies/local-submission")).status).toBe(404);
    writeMessage(agent.paths.inbox, { v: 1, kind: "notification", id: "notice", from: "agent:fixture", to: "token:alice", text: "hello", at: 1 });
    await agent.poll();
    expect(await (await request("bob", "messages")).json()).toEqual({ messages: [] });
    expect(await (await request("alice", "messages")).json()).toMatchObject({ messages: [expect.objectContaining({ id: "notice" })] });
    expect((await request("bob", "messages/notice")).status).toBe(404);
    expect((await request("alice", "messages/notice")).status).toBe(200);
    expect((await request("alice", "messages/notice")).status).toBe(200);
    expect(isMessage({ v: 1, id: "bad", kind: "request", text: "x", from: "local:alice\nforged", at: 1 })).toBe(false);
  } finally { await agent.stop(); rmSync(dir, { recursive: true, force: true }); }
});
