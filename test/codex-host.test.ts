import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/host/agent.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { bindRuntime } from "../src/grant/bind.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { newId, readReply, writeMessage } from "../src/protocol/wire.ts";

async function until<T>(fn: () => T | undefined): Promise<T> {
  for (let i = 0; i < 500; i++) {
    try { const value = fn(); if (value !== undefined) return value; } catch {}
    await Bun.sleep(20);
  }
  throw new Error("Codex host did not reach expected state");
}

test.each([false, true])("Codex backend serves through stdio + host IPC, reuses and resumes its thread (sandboxed=%s)", async (sandboxed) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "endo-codex-host-")));
  const paths = pathsOf(directory);
  const command = join(directory, "fixture-codex");
  writeFileSync(command, `#!${process.execPath}\n${readFileSync(join(import.meta.dir, "fixtures/codex-app-server.ts"), "utf8")}`, { mode: 0o755 });
  mkdirSync(join(paths.state, "program"), { recursive: true });
  writeFileSync(paths.grant, `name="codex-test"\n[executor]\nbackend="codex"\ncommand=${JSON.stringify(command)}\n[inception]\nmode="manual"\n${sandboxed ? '[sandbox]\nnetwork="offline"\n' : ''}`);
  writeFileSync(join(directory, "manifest.md"), "Reply to requests.");
  writeFileSync(paths.program, `import { createNode, createSourceInstance, defineProgram, tool } from "endograph";
import { readdirSync, writeFileSync } from "node:fs";
if (${sandboxed}) {
  let readable = false, writable = false;
  try { readdirSync(${JSON.stringify(join(paths.local, "executors", "codex"))}); readable = true; } catch {}
  try { writeFileSync(${JSON.stringify(join(paths.local, "executors", "codex", "probe"))}, "bad"); writable = true; } catch {}
  if (readable || writable) throw new Error("Worker can access protected Codex session metadata");
}
export default defineProgram(endo => { const node = createNode({key:"test",instructions:"Reply to requests.",parts:Object.values(endo.actions).map(a=>tool(a)),runtime:{type:"generator",trigger:{type:"actor-frame"}}}); return {nodes:[node],instance:createSourceInstance({id:"agent",node})}; });`);
  const grant = await loadGrant(paths);
  expect(grant.executor).toMatchObject({ backend: "codex", command });
  // Binding for inspection/validation must not spawn the backend.
  if (!sandboxed) expect((await bindRuntime(paths, grant)).executor.create().identity?.name).toBe("codex");
  let host = await createAgentHost({ agentDir: directory });
  let running: Promise<number> | undefined;
  const serve = async (text: string) => {
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text, at: Date.now() });
    const reply = await until(() => readReply(paths.outbox, id) ?? undefined);
    expect(reply.ok).toBe(true);
    await until(() => {
      const status = JSON.parse(readFileSync(paths.status, "utf8"));
      return status.active === false && status.open.length === 0 ? true : undefined;
    });
    return reply.text;
  };
  try {
    running = host.run();
    const first = await serve("first");
    expect(await serve("second")).toBe(first);
    await host.close();
    await running;
    host = await createAgentHost({ agentDir: directory });
    running = host.run();
    expect(await serve("after restart")).toBe(first);
  } finally { await host.close(); await running; rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
