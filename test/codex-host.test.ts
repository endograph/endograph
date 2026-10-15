import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/host/agent.ts";
import { pathsOf } from "../src/harness/paths.ts";
import { newId, readReply, writeMessage } from "../src/protocol/wire.ts";

async function until<T>(fn: () => T | undefined): Promise<T> {
  for (let i = 0; i < 500; i++) {
    try { const value = fn(); if (value !== undefined) return value; } catch {}
    await Bun.sleep(20);
  }
  throw new Error("Codex host did not reach expected state");
}

test("a sandboxed worker reaches Codex only through host IPC, and a changed backend config is refused until restart", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "endo-codex-host-")));
  const paths = pathsOf(directory);
  const command = join(directory, "fixture-codex");
  writeFileSync(command, `#!${process.execPath}\n${readFileSync(join(import.meta.dir, "fixtures/codex-app-server.ts"), "utf8")}`, { mode: 0o755 });
  mkdirSync(join(paths.state, "program"), { recursive: true });
  const grant = (extra = "") => `name="codex-test"\n[executor]\nbackend="codex"\ncommand=${JSON.stringify(command)}\n${extra}[inception]\nmode="manual"\n[sandbox]\nnetwork="offline"\n`;
  writeFileSync(paths.grant, grant());
  writeFileSync(join(directory, "manifest.md"), "Reply to requests.");
  writeFileSync(paths.program, `import { createNode, createSourceInstance, defineProgram, tool } from "endograph";
import { readdirSync, writeFileSync } from "node:fs";
{
  let readable = false, writable = false;
  try { readdirSync(${JSON.stringify(join(paths.local, "executors", "codex"))}); readable = true; } catch {}
  try { writeFileSync(${JSON.stringify(join(paths.local, "executors", "codex", "probe"))}, "bad"); writable = true; } catch {}
  if (readable || writable) throw new Error("Worker can access protected Codex session metadata");
}
export default defineProgram(endo => { const node = createNode({key:"test",instructions:"Reply to requests.",parts:Object.values(endo.actions).map(a=>tool(a)),runtime:{type:"generator",trigger:{type:"actor-frame"}}}); return {nodes:[node],instance:createSourceInstance({id:"agent",node})}; });`);
  const host = await createAgentHost({ agentDir: directory });
  let running: Promise<number> | undefined;
  const serve = async (text: string) => {
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text, at: Date.now() });
    const reply = await until(() => readReply(paths.outbox, id) ?? undefined);
    await until(() => {
      const status = JSON.parse(readFileSync(paths.status, "utf8"));
      return status.active === false && status.open.length === 0 ? true : undefined;
    });
    return reply;
  };
  try {
    running = host.run();
    expect((await serve("first")).ok).toBe(true);
    writeFileSync(paths.grant, grant('model="another"\n'));
    expect(await serve("second")).toMatchObject({ ok: false, text: expect.stringContaining("configuration changed; restart the worker") });
  } finally { await host.close(); await running; rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
