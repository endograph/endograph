import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createHostBroker } from "../src/host/broker.ts";
import { createHostClient } from "../src/host/client.ts";
import { hostAction, HostActionError, type HostAction } from "../src/host/action.ts";
import { ipcTransport } from "../src/host/transport.ts";
import { ipcPair } from "./fixtures/ipc.ts";

const root = resolve(import.meta.dir, "..");

test("host handlers run in the parent; child receives data/proxies without the parent's credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-host-"));
  const childFile = join(dir, "child.ts");
  const credential = "only-the-trusted-parent-has-this";
  const previous = process.env.ENDO_TEST_HOST_SECRET;
  process.env.ENDO_TEST_HOST_SECRET = credential;
  writeFileSync(childFile, `
    import { createHostClient } from ${JSON.stringify(join(root, "src/host/client.ts"))};
    import { ipcTransport } from ${JSON.stringify(join(root, "src/host/transport.ts"))};
    const client = createHostClient({ transport: ipcTransport(process) });
    const descriptors = await client.describe();
    const actions = await client.actions();
    const value = await client.call("sentryApi", { issue: 42 });
    console.log(JSON.stringify({ credential: process.env.ENDO_TEST_HOST_SECRET ?? null, descriptors, actions: actions.map(a=>a.name), value }));
    client.close();
  `);
  const { ENDO_TEST_HOST_SECRET: _, ...env } = process.env;
  const child = spawn(process.execPath, [childFile], { env, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => output += chunk);
  child.stderr!.on("data", (chunk) => errors += chunk);
  const broker = createHostBroker({
    identity: "agent:fixture",
    transport: ipcTransport(child),
    actions: () => [hostAction({
      name: "sentryApi",
      description: "Read one issue",
      inputSchema: z.object({ issue: z.number().int() }).strict(),
      async run(args, context) {
        expect(process.env.ENDO_TEST_HOST_SECRET).toBe(credential);
        return { issue: args.issue, identity: context.identity, authorized: true };
      },
    })],
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(errors).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result).toMatchObject({ credential: null, actions: ["sentryApi"], value: { issue: 42, identity: "agent:fixture", authorized: true } });
    expect(JSON.stringify(result.descriptors)).not.toContain(credential);
    expect(Object.keys(result.descriptors[0]).sort()).toEqual(["description", "inputSchema", "name"]);
  } finally {
    broker.close(); rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ENDO_TEST_HOST_SECRET; else process.env.ENDO_TEST_HOST_SECRET = previous;
  }
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
