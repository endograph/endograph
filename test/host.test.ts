import { expect, test } from "bun:test";
import { z } from "zod";
import { createHostBroker } from "../src/host/broker.ts";
import { createHostClient } from "../src/host/client.ts";
import { hostAction, HostActionError, type HostAction } from "../src/host/action.ts";
import { ipcPair } from "./fixtures/ipc.ts";

test("the client receives descriptors and proxies; handlers run in the host with its identity", async () => {
  const transports = ipcPair();
  const broker = createHostBroker({
    identity: "agent:fixture", transport: transports.server,
    actions: () => [hostAction({
      name: "sentryApi", description: "Read one issue", inputSchema: z.object({ issue: z.number().int() }).strict(),
      run: (args, context) => ({ issue: args.issue, identity: context.identity }),
    })],
  });
  const client = createHostClient({ transport: transports.client });
  try {
    const descriptors = await client.describe();
    expect(descriptors.map((d) => Object.keys(d).sort())).toEqual([["description", "inputSchema", "name"]]);
    expect((await client.actions()).map((a) => a.name)).toEqual(["sentryApi"]);
    expect(await client.call("sentryApi", { issue: 42 })).toEqual({ issue: 42, identity: "agent:fixture" });
  } finally { client.close(); broker.close(); }
});

test("schema checks and current grants apply to cached proxies; ordinary handler exceptions are redacted", async () => {
  const transports = ipcPair();
  let invoked = 0;
  let actions: HostAction[] = [hostAction({ name: "readIssue", description: "read", inputSchema: z.object({ id: z.number() }).strict(), run: ({ id }) => { invoked++; return { id }; } })];
  const broker = createHostBroker({ identity: "bound", transport: transports.server, actions: async () => actions });
  const client = createHostClient({ transport: transports.client });
  try {
    const proxies = await client.actions();
    expect(proxies.map((a) => a.name)).toEqual(["readIssue"]);
    await expect(client.call("readIssue", { id: "bad" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(invoked).toBe(0);
    expect(await client.call("readIssue", { id: 1 })).toEqual({ id: 1 });
    actions = [];
    await expect(client.call(proxies[0]!.name, { id: 2 })).rejects.toMatchObject({ code: "denied" });
    expect(await proxies[0]!.run!({ id: 2 }, {} as never)).toMatchObject({ success: false, error: "host action is not granted" });
    expect(invoked).toBe(1);
    actions = [hostAction({ name: "fail", description: "fails", inputSchema: z.object({ public: z.boolean() }), run({ public: visible }) { if (visible) throw new HostActionError("issue unavailable"); throw new Error("SECRET=credential"); } })];
    await expect(client.call("fail", { public: false })).rejects.toThrow("host action failed");
    await expect(client.call("fail", { public: true })).rejects.toThrow("issue unavailable");
  } finally { client.close(); broker.close(); }
});

test("a host action can wake its agent after returning; without delivery, emitting throws", async () => {
  const transports = ipcPair();
  const emitted: { action: string; text: string; ref?: string }[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const delivered = Promise.withResolvers<void>();
  const background = hostAction({
    name: "startJob", description: "start work that outlives the call", inputSchema: z.object({ ref: z.string() }).strict(),
    run({ ref }, context) {
      void finished.then(() => context.emitMessage({ text: "job finished", ref }));
      return { started: true };
    },
  });
  const broker = createHostBroker({
    identity: "agent:fixture", transport: transports.server, actions: () => [background],
    emitMessage: (action, message) => { emitted.push({ action, ...message }); delivered.resolve(); return { id: "m1" }; },
  });
  const client = createHostClient({ transport: transports.client });
  try {
    expect(await client.call("startJob", { ref: "req-1" })).toEqual({ started: true });
    expect(emitted).toEqual([]);
    finish();
    await delivered.promise;
    expect(emitted).toEqual([{ action: "startJob", text: "job finished", ref: "req-1" }]);
  } finally { client.close(); broker.close(); }

  const bare = ipcPair();
  const undelivered = createHostBroker({ identity: "agent:fixture", transport: bare.server, actions: () => [hostAction({
    name: "emitNow", description: "emit immediately", inputSchema: z.object({}), run: (_args, context) => context.emitMessage({ text: "x" }),
  })] });
  const bareClient = createHostClient({ transport: bare.client });
  try {
    await expect(bareClient.call("emitNow", {})).rejects.toThrow("messages are unavailable to this host action");
  } finally { bareClient.close(); undelivered.close(); }
});

test("raw identity injection and malformed requests are denied; host in-flight bounds survive client cancellation", async () => {
  const transports = ipcPair();
  const responses: Record<string, unknown>[] = [];
  let released!: () => void;
  let invoked = 0;
  const hold = new Promise<void>((resolve) => released = resolve);
  const broker = createHostBroker({ identity: "trusted", maxInFlight: 1, timeoutMs: 1000, transport: transports.server, actions: () => [hostAction({ name: "hold", description: "wait", inputSchema: z.object({}), async run() { invoked++; await hold; return true; } })] });
  const unsubscribe = transports.client.subscribe((raw) => responses.push(JSON.parse(raw)), () => {});
  const send = (body: object) => transports.client.send(JSON.stringify({ v: 1, ...body }));
  try {
    send({ kind: "call", id: "spoof", name: "hold", args: {}, identity: "somebody-else" });
    send({ kind: "eval", id: "eval", code: "secret" });
    send({ kind: "call", id: "one", name: "hold", args: {} });
    await Bun.sleep(10);
    send({ kind: "cancel", id: "one" });
    send({ kind: "call", id: "two", name: "hold", args: {} });
    await Bun.sleep(10);
    expect(responses).toContainEqual(expect.objectContaining({ id: "spoof", error: { code: "bad_request", message: "malformed host request" } }));
    expect(responses).toContainEqual(expect.objectContaining({ id: "eval", error: { code: "bad_request", message: "malformed host request" } }));
    expect(responses).toContainEqual(expect.objectContaining({ id: "two", error: { code: "busy", message: "too many host requests" } }));
    expect(invoked).toBe(1);
    released();
    await Bun.sleep(10);
    expect(responses.some((response) => response.id === "one")).toBe(false);
    send({ kind: "call", id: "three", name: "hold", args: {} });
    await Bun.sleep(10);
    expect(responses).toContainEqual({ v: 1, id: "three", ok: true, value: true });
    expect(invoked).toBe(2);
  } finally { released(); unsubscribe(); transports.client.close(); broker.close(); }
});

test("timeouts, disconnects, pending limits and oversized requests settle callers", async () => {
  const transports = ipcPair();
  let release!: () => void;
  const hold = new Promise<void>((r) => release = r);
  const broker = createHostBroker({ identity: "x", transport: transports.server, actions: () => [hostAction({ name: "slow", description: "slow", inputSchema: z.any(), async run() { await hold; return null; } })] });
  const client = createHostClient({ transport: transports.client, timeoutMs: 20, maxPending: 1, maxBytes: 512 });
  try {
    const first = client.call("slow", {});
    await expect(client.call("slow", {})).rejects.toMatchObject({ code: "busy" });
    await expect(first).rejects.toMatchObject({ code: "timeout" });
    await expect(client.call("slow", "x".repeat(1000))).rejects.toMatchObject({ code: "too_large" });
    const second = client.call("slow", {});
    broker.close();
    await expect(second).rejects.toMatchObject({ code: "disconnected" });
  } finally { release(); client.close(); broker.close(); }
});
