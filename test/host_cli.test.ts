import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { isLocked } from "../src/harness/lock.ts";
import { newId, readReply, waitForReply, writeMessage } from "../src/protocol/wire.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli/index.ts");

test("CLI sandbox denies direct HTTP while its selected host action reaches the parent service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-host-cli-"));
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  const requests: { path: string; authorization: string | null }[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return Response.json({ issue: "resolved" });
  } });
  const endpoint = `http://127.0.0.1:${service.port}`;
  const unsafeImport = join(dir, "generated-code-imported-in-parent");
  const env = { ...process.env, ENDOGRAPH_HOME: join(dir, "registry") };
  writeFileSync(join(dir, ".env"), "ENDO_SERVICE_SECRET=parent-only-token\n");
  writeFileSync(paths.grant, `name="host-cli"
batteries=[]
host_actions=["sentryApi"]
host_modules=["host/sentry.ts"]
[executor]
module=".endo/scripted.ts"
[inception]
mode="manual"
[sandbox]
network="offline"
`);
  writeFileSync(join(dir, "manifest.md"), "Check the service and its local access boundary.");
  mkdirSync(join(dir, "host"));
  writeFileSync(join(dir, "host/sentry.ts"), `
import { hostAction, z } from ${JSON.stringify(join(ROOT, "src/index.ts"))};
export default [hostAction({ name: "sentryApi", description: "Read one issue", inputSchema: z.object({}).strict(),
  async run() { return await (await fetch(${JSON.stringify(endpoint + "/sentry")}, { headers: { authorization: "Bearer " + process.env.ENDO_SERVICE_SECRET } })).json(); }
})];
`);
  writeFileSync(join(paths.state, "scripted.ts"), `
import { writeFileSync } from "node:fs";
try { writeFileSync(${JSON.stringify(unsafeImport)}, "executor"); } catch {}
import { scripted } from ${JSON.stringify(join(ROOT, "test/fixtures/agent/scripted.ts"))};
export default { description: "scripted", create: () => scripted(async (turn) => {
  for (const request of turn.requests) {
    const direct = await turn.call("probe", {});
    const hosted = await turn.call("sentryApi", {});
    await turn.call("reply", { id: request.id, ok: direct.success && hosted.success,
      text: JSON.stringify({ direct: direct.success ? JSON.parse(direct.value) : direct.error, hosted: hosted.success ? hosted.value : hosted.error }) });
  }
}) };
`);
  mkdirSync(join(paths.state, "program"));
  writeFileSync(paths.program, `// .endo/program/agent.ts — written by inception 1 (2026-09-04). Do not edit:
// change manifest.md or endograph.toml and run \`endo incept\`.
import { createNode, createSourceInstance, defineProgram, tool } from "endograph";
import { writeFileSync } from "node:fs";
try { writeFileSync(${JSON.stringify(unsafeImport)}, "program"); } catch {}
export default defineProgram((endo) => {
  const node = createNode({ key: "agent", instructions: "Check the service.", parts: [...Object.values(endo.actions), ...endo.procedures].map(tool), runtime: { type: "generator", trigger: { type: "actor-frame" } } });
  return { nodes: [node], instance: createSourceInstance({ id: "agent", node }) };
});
`);
  writeFileSync(join(paths.procedures, "probe.ts"), `
import { readFileSync } from "node:fs";
import { procedure } from "endograph/procedure";
await procedure({ description: "Check direct access", expose: true });
let networkDenied = false;
try { const response = await fetch(${JSON.stringify(endpoint + "/direct")}, { signal: AbortSignal.timeout(700) }); networkDenied = !response.ok; } catch { networkDenied = true; }
let secretDenied = false;
try { secretDenied = !readFileSync(${JSON.stringify(paths.env)}, "utf8").includes("parent-only-token"); } catch { secretDenied = true; }
console.log(JSON.stringify({ networkDenied, secretDenied, credentialPresent: !!process.env.ENDO_SERVICE_SECRET }));
`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  try {
    const inception = Bun.spawn([process.execPath, "run", CLI, "incept", "--inceptor", "true"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [inceptCode, inceptOutput, inceptErrors] = await Promise.all([inception.exited, new Response(inception.stdout).text(), new Response(inception.stderr).text()]);
    expect({ code: inceptCode, errors: inceptErrors }).toEqual({ code: 0, errors: "" });
    expect(inceptOutput).toContain("inception 1 recorded");
    const spawned = Bun.spawn([process.execPath, "run", CLI, "up", "--foreground"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    child = spawned;
    const stdout = (async () => { for await (const bytes of spawned.stdout) output += new TextDecoder().decode(bytes); return output; })();
    const stderr = new Response(spawned.stderr).text();
    for (let i = 0; i < 400 && !output.includes(" up in "); i++) {
      if (spawned.exitCode !== null) break;
      await Bun.sleep(25);
    }
    if (!output.includes(" up in ")) {
      spawned.kill("SIGTERM");
      throw new Error(`worker did not start: ${output}\n${await stderr}`);
    }
    const id = newId();
    writeMessage(paths.inbox, { v: 1, kind: "request", id, text: "check", at: Date.now() });
    const reply = await waitForReply(paths.outbox, id, { timeoutMs: 8000, pollMs: 25, terminal: true });
    expect(reply?.ok).toBe(true);
    expect(JSON.parse(reply!.text)).toEqual({ direct: { networkDenied: true, secretDenied: true, credentialPresent: false }, hosted: { issue: "resolved" } });
    expect(requests).toEqual([{ path: "/sentry", authorization: "Bearer parent-only-token" }]);
    expect(existsSync(unsafeImport)).toBe(false);
    expect(readReply(paths.outbox, id)).toEqual(reply);
    // Real sandboxed file watchers may open successfully yet deliver no events.
    // New and changed procedures must still become callable while the worker runs.
    for (const version of ["one", "two"]) {
      writeFileSync(join(paths.procedures, "added.ts"), `
import { procedure } from "endograph/procedure";
await procedure({ description: ${JSON.stringify(version)}, expose: true });
console.log(${JSON.stringify(version)});
`);
      let changed = false;
      for (let i = 0; i < 200 && !changed; i++) {
        const status = JSON.parse(readFileSync(paths.status, "utf8"));
        changed = status.commands.some((command: { name: string; description: string }) => command.name === "added" && command.description === version);
        if (!changed) await Bun.sleep(25);
      }
      expect(changed).toBe(true);
      const call = newId();
      writeMessage(paths.inbox, { v: 1, kind: "call", id: call, procedure: "added", args: {}, at: Date.now() });
      expect(await waitForReply(paths.outbox, call, { timeoutMs: 5000, pollMs: 25, terminal: true })).toMatchObject({ ok: true, text: version });
    }
    expect(readReply(paths.outbox, id)).toEqual(reply);
    spawned.kill("SIGTERM");
    expect({ code: await spawned.exited, errors: await stderr }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(readFileSync(paths.status, "utf8")).running).toBe(false);
    expect(isLocked(paths.lock)).toBe(false);
    await stdout;
    child = undefined;
  } finally {
    if (child) { child.kill("SIGKILL"); await child.exited; }
    service.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
