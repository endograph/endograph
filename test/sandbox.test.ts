import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Grant } from "../src/grant/grant.ts";
import { ENDOGRAPH_ROOT, ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { closeSandbox, sandboxCommand } from "../src/host/sandbox.ts";

test("OS sandbox confines agent and descendants while preserving private IPC and explicit environment", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "endo-sandbox-")));
  const dir = join(directory, "agent");
  mkdirSync(dir);
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"));
  writeFileSync(paths.program, "// protected program\n");
  writeFileSync(paths.grant, "owner input");
  writeFileSync(paths.env, "PRIVATE_KEY=secret");
  mkdirSync(join(dir, "host"));
  writeFileSync(join(dir, "host/action.ts"), "// private host implementation\n");
  writeFileSync(join(dir, "host/helper.ts"), "// private host dependency\n");
  writeFileSync(join(directory, "outside.txt"), "outside");
  const grant: Grant = {
    name: "sandbox-test", manifest: { text: "test" }, cwd: ".", batteries: [], hostModules: ["host/action.ts"], hostActions: [],
    executor: { provider: "openai", model: "unused" },
    inception: { mode: "manual", rounds: 1 }, sandbox: { network: "offline", read: [], write: [], env: ["ENDO_TEST_ALLOWED"] },
  };
  const secretBefore = process.env.ENDO_TEST_SECRET;
  const allowedBefore = process.env.ENDO_TEST_ALLOWED;
  const javaBefore = process.env.JAVA_TOOL_OPTIONS;
  process.env.ENDO_TEST_SECRET = "must-stay-in-host";
  process.env.ENDO_TEST_ALLOWED = "explicitly-permitted";
  process.env.JAVA_TOOL_OPTIONS = "-Dtoken=outer-only-token";
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("should not arrive"); } });
  const socketPath = join(paths.state, "host.sock");
  const socketServer = createServer((socket) => { hits++; socket.end(); });
  await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
  const probe = join(paths.src, "probe.ts");
  const directNetwork = `
    import net from "node:net";
    const networkDenied = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: ${server.port} });
      socket.on("connect", () => { socket.destroy(); resolve(false); });
      socket.on("error", () => resolve(true));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    });
  `;
  writeFileSync(probe, `
    import { readFileSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
    import { spawnSync } from "node:child_process";
    import { defineProgram } from "endograph";
    ${directNetwork}
    const unixDenied = await new Promise((resolve) => {
      const socket = net.connect(${JSON.stringify(socketPath)});
      socket.on("connect", () => { socket.destroy(); resolve(false); });
      socket.on("error", () => resolve(true));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    });
    let httpDenied = false;
    try { httpDenied = (await fetch("http://127.0.0.1:${server.port}/", { signal: AbortSignal.timeout(1000) })).status === 403; }
    catch { httpDenied = true; }
    const denied = (fn) => { try { fn(); return false; } catch { return true; } };
    // Linux may mask a denied file with /dev/null instead of rejecting open().
    const unavailable = (path, contents) => { try { return !readFileSync(path, "utf8").includes(contents); } catch { return true; } };
    const denyOpenWrite = (path) => denied(() => { const fd = openSync(path, "r+"); closeSync(fd); });
    writeFileSync(${JSON.stringify(join(paths.src, "allowed.txt"))}, "allowed");
    writeFileSync(process.env.TMPDIR + "/private-temp.txt", "temp");
    const child = spawnSync(process.execPath, ["--no-env-file", "--eval", ${JSON.stringify(`${directNetwork}
      import { readFileSync } from "node:fs";
      let denied = false; try { denied = !readFileSync(${JSON.stringify(paths.env)}, "utf8").includes("PRIVATE_KEY=secret"); } catch { denied = true; }
      console.log(JSON.stringify({ networkDenied, secretDenied: denied, credentialPresent: !!process.env.ENDO_TEST_SECRET }));`)}], { encoding: "utf8", timeout: 5000 });
    const incoming = readFileSync(3, "utf8");
    writeSync(4, "private-ipc:" + incoming);
    console.log(JSON.stringify({
      runtimeImported: typeof defineProgram === "function", networkDenied, unixDenied, httpDenied,
      credentialPresent: !!process.env.ENDO_TEST_SECRET, allowedEnv: process.env.ENDO_TEST_ALLOWED,
      javaSecretPresent: (process.env.JAVA_TOOL_OPTIONS ?? "").includes("outer-only-token"), privateTemp: process.env.TMPDIR,
      envDenied: unavailable(${JSON.stringify(paths.env)}, "PRIVATE_KEY=secret"),
      codexDenied: unavailable(${JSON.stringify(join(paths.local, "executors/codex/session.json"))}, "private-session"),
      codexWriteDenied: denied(() => {
        writeFileSync(${JSON.stringify(join(paths.local, "executors/codex/injected.json"))}, "bad");
        writeFileSync(${JSON.stringify(join(paths.local, "executors/codex/session.json"))}, "bad");
      }),
      hostDenied: denied(() => readFileSync(${JSON.stringify(join(dir, "host/action.ts"))})),
      hostHelperWriteDenied: denyOpenWrite(${JSON.stringify(join(dir, "host/helper.ts"))}),
      outsideDenied: denied(() => readFileSync(${JSON.stringify(join(directory, "outside.txt"))})),
      outsideWriteDenied: denied(() => {
        writeFileSync(${JSON.stringify(join(directory, "outside-write.txt"))}, "bad");
        writeFileSync(${JSON.stringify(join(directory, "outside.txt"))}, "bad");
      }),
      agentRootWriteDenied: denied(() => writeFileSync(${JSON.stringify(join(dir, "ungranted.txt"))}, "bad")),
      grantWriteDenied: denyOpenWrite(${JSON.stringify(paths.grant)}),
      programWriteDenied: denyOpenWrite(${JSON.stringify(paths.program)}),
      runtimeWriteDenied: denyOpenWrite(${JSON.stringify(join(ENDOGRAPH_ROOT, "src/index.ts"))}),
      allowedWrite: readFileSync(${JSON.stringify(join(paths.src, "allowed.txt"))}, "utf8"),
      childExit: child.status, child: child.stdout.trim(), childError: child.stderr.trim(),
    }));
  `);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const module of ["host.ts", ".endo/src/action.ts"]) {
      await expect(sandboxCommand(paths, { ...grant, hostModules: [module] }, [process.execPath, "run", probe])).rejects.toThrow("dedicated owner directory");
    }
    const wrapped = await sandboxCommand(paths, grant, [process.execPath, "run", probe]);
    mkdirSync(join(paths.local, "executors/codex"), { recursive: true });
    writeFileSync(join(paths.local, "executors/codex/session.json"), "private-session");
    expect(wrapped.env.ENDO_TEST_SECRET).toBeUndefined();
    expect(wrapped.env.ENDO_TEST_ALLOWED).toBe("explicitly-permitted");
    child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), { cwd: dir, env: wrapped.env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let ipc = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    (child.stdio[4] as Readable).on("data", (chunk) => { ipc += chunk; });
    (child.stdio[3] as Writable).end("roundtrip");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 15000);
    const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); }).finally(() => clearTimeout(timer));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      runtimeImported: true, networkDenied: true, unixDenied: true, httpDenied: true, credentialPresent: false, allowedEnv: "explicitly-permitted",
      javaSecretPresent: false, privateTemp: join(paths.state, "tmp"),
      envDenied: true, codexDenied: true, hostDenied: true, hostHelperWriteDenied: true, outsideDenied: true,
      agentRootWriteDenied: true, grantWriteDenied: true, programWriteDenied: true, runtimeWriteDenied: true, allowedWrite: "allowed", childExit: 0,
    });
    // Linux hides read-denied directories behind private tmpfs mounts. Writes
    // there may succeed, but must never create or overwrite files on the host.
    if (process.platform !== "linux") expect(result).toMatchObject({ codexWriteDenied: true, outsideWriteDenied: true });
    expect(existsSync(join(paths.local, "executors/codex/injected.json"))).toBe(false);
    expect(readFileSync(join(paths.local, "executors/codex/session.json"), "utf8")).toBe("private-session");
    expect(existsSync(join(directory, "outside-write.txt"))).toBe(false);
    expect(readFileSync(join(directory, "outside.txt"), "utf8")).toBe("outside");
    expect(JSON.parse(result.child)).toEqual({ networkDenied: true, secretDenied: true, credentialPresent: false });
    expect(ipc).toBe("private-ipc:roundtrip");
    expect(hits).toBe(0);
    // A later grant can broaden ordinary writes without making the host's
    // imported helper code mutable. This also exercises sequential policies.
    const broader = await sandboxCommand(paths, { ...grant, sandbox: { ...grant.sandbox!, write: ["."] } }, [process.execPath, "--eval", `
      import { openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(dir, "explicitly-allowed.txt"))}, "allowed");
      let helperProtected = false, stateRenameDenied = false, localRenameDenied = false, hostRenameDenied = false, leaked = false;
      try { const fd = openSync(${JSON.stringify(join(dir, "host/helper.ts"))}, "r+"); closeSync(fd); }
      catch { helperProtected = true; }
      try { renameSync(${JSON.stringify(paths.local)}, ${JSON.stringify(join(paths.state, "moved-local"))}); }
      catch { localRenameDenied = true; }
      try { renameSync(${JSON.stringify(paths.state)}, ${JSON.stringify(join(dir, "moved-state"))}); }
      catch { stateRenameDenied = true; }
      if (!stateRenameDenied) try { leaked = readFileSync(${JSON.stringify(join(dir, "moved-state/local/executors/codex/session.json"))}, "utf8").includes("private-session"); } catch {}
      try { renameSync(${JSON.stringify(join(dir, "host"))}, ${JSON.stringify(join(dir, "moved-host"))}); }
      catch { hostRenameDenied = true; }
      console.log(JSON.stringify({ helperProtected, stateRenameDenied, localRenameDenied, hostRenameDenied, leaked }));
    `]);
    const next = Bun.spawn(broader.argv, { cwd: dir, env: broader.env, stdout: "pipe", stderr: "pipe" });
    const [nextCode, nextOut, nextErr] = await Promise.all([next.exited, new Response(next.stdout).text(), new Response(next.stderr).text()]);
    expect(nextCode).toBe(0);
    expect(nextErr).toBe("");
    for (const [from, to] of [[join(dir, "moved-state"), paths.state], [join(dir, "moved-host"), join(dir, "host")]]) {
      if (existsSync(from!)) renameSync(from!, to!);
    }
    expect(JSON.parse(nextOut)).toEqual({ helperProtected: true, stateRenameDenied: true, localRenameDenied: true, hostRenameDenied: true, leaked: false });
  } finally {
    child?.kill("SIGKILL");
    server.stop(true);
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await closeSandbox();
    if (secretBefore === undefined) delete process.env.ENDO_TEST_SECRET; else process.env.ENDO_TEST_SECRET = secretBefore;
    if (allowedBefore === undefined) delete process.env.ENDO_TEST_ALLOWED; else process.env.ENDO_TEST_ALLOWED = allowedBefore;
    if (javaBefore === undefined) delete process.env.JAVA_TOOL_OPTIONS; else process.env.JAVA_TOOL_OPTIONS = javaBefore;
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
