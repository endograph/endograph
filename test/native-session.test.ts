import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runNativeSession, type NativeTerminal } from "../src/cli/native-session.ts";
import type { Harness } from "../src/inception/harnesses.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const id = "12345678-1234-1234-1234-123456789abc";
function fixture(mode = "finish", harness: Harness = "codex") {
  const directory = mkdtempSync(join(tmpdir(), "endo-native-test-"));
  dirs.push(directory);
  const file = join(directory, "codex.ts");
  writeFileSync(file, `
    import { writeFileSync } from 'node:fs';
    process.stdin.setRawMode(true);
    const args = process.argv.slice(2);
    if (${JSON.stringify(harness)} === 'codex') process.env.CODEX_THREAD_ID = ${JSON.stringify(id)};
    else if (process.env.ENDOGRAPH_SESSION_ID !== args[args.indexOf('--resume') + 1] && process.env.ENDOGRAPH_SESSION_ID !== args[args.indexOf('--session-id') + 1]) process.exit(3);
    console.log(JSON.stringify({args}));
    let received = '';
    process.stdin.on('data', (data) => {
      received += data.toString();
      if (data.includes(3)) console.log('TURN_INTERRUPTED');
      if (received.includes(${JSON.stringify(harness === "codex" ? "/quit\r" : "/exit\r")})) { writeFileSync(${JSON.stringify(join(directory, "quit-received"))}, 'yes'); console.log('GRACEFUL_EXIT'); process.exit(${mode === "failed" ? 1 : 0}); }
    });
    async function handshake(action) {
      const child = Bun.spawn([process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli/index.ts"))}, process.env.ENDOGRAPH_SESSION_PURPOSE === 'inception' ? 'incept' : 'setup', action], {env: process.env, stdout:'pipe', stderr:'pipe'});
      const code = await child.exited;
      if (code !== 0) { console.error(await new Response(child.stderr).text()); process.exit(2); }
    }
    await handshake('ready');
    console.log('READY');
    if (${JSON.stringify(mode)} === 'quit') process.exit(0);
    if (${JSON.stringify(mode)} !== 'cancel') await handshake('finish');
  `);
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: 100, rows: 40 });
  let text = "";
  output.on("data", (data: Buffer) => {
    text += data.toString();
    if (mode === "cancel" && text.includes("READY")) input.emit("end");
  });
  return { harness, directory, command: [process.execPath, file], terminal: { input, output } satisfies NativeTerminal, text: () => text };
}

test.each(["codex", "claude"] as const)("%s setup saves its session, hands off through the real CLI helper, and restores terminal state", async (harness) => {
  const f = fixture("finish", harness);
  const saved: { harness: Harness; threadId: string }[] = [];
  await runNativeSession({ ...f, instructions: "Configure the draft", save: (session) => saved.push(session) });
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual(saved[1]!);
  expect(saved[0]!.harness).toBe(harness);
  if (harness === "codex") expect(saved[0]!.threadId).toBe(id);
  else expect(f.text()).toContain(`"--session-id","${saved[0]!.threadId}"`);
  expect(existsSync(join(f.directory, "quit-received"))).toBe(true);
  expect(f.text()).not.toContain("TURN_INTERRUPTED");
  expect(f.text()).not.toContain("GRACEFUL_EXIT");
  expect(f.text()).toContain("Configure the draft");
  expect(f.terminal.input.isRaw).toBe(false);
  expect(f.terminal.input.isPaused()).toBe(true);
  expect(f.terminal.input.listenerCount("data")).toBe(0);
});

test.each([["codex", '"resume"'], ["claude", '"--resume"']] as const)("%s resume uses the exact saved session", async (harness, flag) => {
  const f = fixture("finish", harness);
  const saved: string[] = [];
  await runNativeSession({ ...f, instructions: "Revise the draft", previous: { harness, threadId: id }, save: (session) => saved.push(session.threadId) });
  expect(f.text()).toContain(flag);
  expect(f.text()).toContain(id);
  expect(saved).toEqual([id, id]);
});

test("a session stored by another harness starts a fresh conversation", async () => {
  const f = fixture("finish", "claude");
  const saved: string[] = [];
  await runNativeSession({ ...f, instructions: "Revise the draft", previous: { harness: "codex", threadId: id }, save: (session) => saved.push(session.threadId) });
  expect(f.text()).not.toContain("--resume");
  expect(saved[0]).not.toBe(id);
});

test.each(["quit", "failed", "cancel"])("%s cannot publish setup even after a clean process exit", async (mode) => {
  const f = fixture(mode);
  await expect(runNativeSession({ ...f, instructions: "setup", save: () => {} })).rejects.toThrow("unfinished");
  if (mode === "cancel") expect(f.text()).toContain("TURN_INTERRUPTED");
  expect(f.terminal.input.isRaw).toBe(false);
  expect(f.terminal.input.listenerCount("data")).toBe(0);
});

test("a different thread cannot complete a resumed session", async () => {
  const f = fixture();
  await expect(runNativeSession({ ...f, instructions: "setup", previous: { harness: "codex", threadId: "87654321-1234-1234-1234-123456789abc" }, save: () => { throw new Error("must not save"); } })).rejects.toThrow("unfinished");
  expect(f.text()).toContain("Session mismatch");
});

test("the handshake server accepts only this invocation's token and a well-formed body", async () => {
  const f = fixture();
  const statuses = join(f.directory, "statuses.json");
  const probe = join(f.directory, "probe.ts");
  writeFileSync(probe, `
    import { writeFileSync } from 'node:fs';
    process.stdin.setRawMode(true);
    let received = '';
    process.stdin.on('data', (data) => { received += data.toString(); if (received.includes('/quit\\r')) process.exit(0); });
    const post = (headers, body) => fetch(process.env.ENDOGRAPH_SESSION_URL, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.status);
    const auth = { authorization: 'Bearer ' + process.env.ENDOGRAPH_SESSION_TOKEN };
    const finish = { action: 'finish', threadId: ${JSON.stringify(id)} };
    writeFileSync(${JSON.stringify(statuses)}, JSON.stringify([
      await post({}, finish), await post({ authorization: 'Bearer wrong' }, finish),
      await post(auth, { ...finish, threadId: 'not-a-thread' }), await post(auth, { ...finish, action: 'promote' }),
    ]));
    await post(auth, finish);
  `);
  const saved: string[] = [];
  await runNativeSession({ ...f, command: [process.execPath, probe], instructions: "setup", save: (session) => saved.push(session.threadId) });
  expect(JSON.parse(readFileSync(statuses, "utf8"))).toEqual([401, 401, 400, 400]);
  expect(saved).toEqual([id]);
});
