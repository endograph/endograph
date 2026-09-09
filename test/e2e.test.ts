import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { allFrames } from "../src/store/types.ts";
import { scaffold, ROOT } from "./harness.test.ts";

const ENDO = join(ROOT, "src/cli/index.ts");
const env = { ...process.env, ENDO_FIXTURES: join(ROOT, "test/fixtures"), ENDOGRAPH_HOME: mkdtempSync(join(tmpdir(), "endo-home-")) };

async function endo(cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, ENDO, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
}

// Initial inception can perform several worker loads, each with a 60s limit.
// Drain both pipes immediately, and report the process's diagnostics on failure.
function startAgent(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ENDO, "up", "--foreground", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) append(decoder.decode(bytes, { stream: true }));
    append(decoder.decode());
  };
  const drained = Promise.all([drain(child.stdout, (text) => stdout += text), drain(child.stderr, (text) => stderr += text)]);
  void child.exited.then((code) => { exitCode = code; });
  const failure = (reason: string) => new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const waitFor = async (label: string, ready: () => boolean) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        await drained;
        throw failure(`agent exited ${exitCode} (${child.signalCode ?? "no signal"}) before ${label}`);
      }
      if (ready()) return;
      await Bun.sleep(100);
    }
    throw failure(`timed out after 90s waiting for ${label}`);
  };
  return {
    waitFor,
    output: () => stdout,
    ready: () => waitFor("serving readiness", () => {
      const status = join(cwd, ".endo/status.json");
      try { return /^fixture up in /m.test(stdout) && JSON.parse(readFileSync(status, "utf8")).running === true; }
      catch { return false; } // The live status file can be between writes.
    }),
    async stop() {
      if (exitCode === undefined) child.kill("SIGTERM");
      const timer = setTimeout(() => { if (exitCode === undefined) child.kill("SIGKILL"); }, 5000);
      try { await child.exited; await drained; } finally { clearTimeout(timer); }
    },
  };
}

test("empty state dir → inception with a fixture inceptor (two rounds) → a served request, all through the CLI", async () => {
  const dir = scaffold({ program: false, procedures: false });
  expect(existsSync(join(dir, ".endo/program/agent.ts"))).toBe(false);

  // `endo up` with no program runs inception first, then serves. Run it in the background.
  const up = startAgent(dir, "--inceptor", `${process.execPath} ${join(ROOT, "test/fixtures/inceptor.ts")}`);
  try {
    await up.ready();
    expect(readdirSync(join(dir, ".endo/snapshots"))).toEqual(["1"]);
    expect(readFileSync(join(dir, ".endo/program/agent.ts"), "utf8")).toMatch(/^\/\/ \.endo\/program\/agent\.ts — written by inception 1/);

    expect(await endo(dir, "send", "--wait", "what is 2+2?")).toMatchObject({ code: 0, out: "4" });
    // Registered by `up`: reachable by name from anywhere, and send stamps the caller's directory and git HEAD.
    const repo = mkdtempSync(join(tmpdir(), "endo-repo-"));
    Bun.spawnSync(["sh", "-c", "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && touch dirty"], { cwd: repo });
    expect(await endo(repo, "--agent", "fixture", "send", "--wait", "what is 2+2?")).toMatchObject({ code: 0, out: "4" });
    expect((await endo(dir, "--agent", "fixture", "status")).out).toMatch(/fixture: up, idle/);
    expect((await endo(repo, "--agent", "nobody", "send", "hi")).err).toMatch(/no agent "nobody"/);
    expect(await endo(dir, "call", "--wait", "hello", "NAME=cli")).toMatchObject({ code: 0, out: "hello cli" });
    expect((await endo(dir, "status")).out).toMatch(/fixture: up, idle, 0 open request\(s\), 0 running/);
    // A consumer command aimed at a directory with no grant refuses instead of inventing a state directory there.
    expect(await endo(dir, "send", "--agent", "nowhere", "hi")).toMatchObject({ code: 1, err: expect.stringMatching(/no agent "nowhere"/) });
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
  } finally {
    await up.stop();
  }

  const store = openSqliteStore(join(dir, ".endo/agent.db"));
  const frames = [...allFrames(store)];
  const inception = frames.find((f) => f.type === "inception");
  store.close();
  const stamped = frames.filter((f) => f.type === "request").at(-1)?.payload as { metadata: { endo: { requests: { origin?: string; ref?: string }[] } } };
  expect(stamped.metadata.endo.requests[0]).toMatchObject({ origin: expect.stringContaining("endo-repo-"), ref: expect.stringMatching(/^[0-9a-f]{40}-dirty$/) });
  expect(existsSync(join(dir, ".endo/workspace/CLI.md"))).toBe(true);
  expect(inception?.summary).toBe("inception 1 after 2 rounds");
  expect(inception?.payload).toMatchObject({ n: 1, rounds: 2, version: expect.any(String) });
  expect(existsSync(join(dir, ".endo/workspace/ERRORS.md"))).toBe(false);
  // The record: the workspace as read, and both rounds with what the inceptor said, wrote, and got back.
  const record = join(dir, ".endo/inceptions/1");
  expect(JSON.parse(readFileSync(join(record, "inception.json"), "utf8"))).toMatchObject({ n: 1, rounds: 2, outcome: "recorded", inceptor: expect.stringContaining("inceptor.ts") });
  expect(existsSync(join(record, "workspace/TASK.md"))).toBe(true);
  expect(readdirSync(join(record, "rounds/1")).sort()).toEqual(["ERRORS.md", "agent.ts", "round.json", "src", "stdout.txt"]);
  expect(JSON.parse(readFileSync(join(record, "rounds/1/round.json"), "utf8"))).toMatchObject({ round: 1, passed: false, stage: "program", exitCode: 0 });
  expect(readFileSync(join(record, "rounds/1/agent.ts"), "utf8")).toMatch(/do not edit/);
  expect(readFileSync(join(record, "rounds/1/stdout.txt"), "utf8")).toMatch(/fixture inceptor wrote the program/);
  expect(JSON.parse(readFileSync(join(record, "rounds/2/round.json"), "utf8"))).toMatchObject({ round: 2, passed: true });
  expect(existsSync(join(record, "rounds/2/ERRORS.md"))).toBe(false);

  // Owner commands with the agent down.
  expect((await endo(dir, "charter")).out).toMatch(/### reply[\s\S]*### bash[\s\S]*### spawn[\s\S]*`schedule` \(scheduler\)/);
  const asked = frames.find((f) => f.type === "request")!.id!;
  const why = (await endo(dir, "why", asked)).out;
  expect(why).toMatch(/request .*what is 2\+2\?/);
  expect(why).toMatch(/→ reply .*"text":"4"/);
  expect(why).not.toMatch(/hello cli/);
  expect(await endo(dir, "doctor")).toMatchObject({ code: 0, out: expect.stringMatching(/inputs unchanged since inception 1/) });

  // The owner edits the manifest: status says an inception is due; inception 2 gets a baseline and a diff, and keeps src.
  appendFileSync(join(dir, "manifest.md"), "\nAlso: be brief.\n");
  expect((await endo(dir, "status")).out).toMatch(/inputs changed since inception 1: manifest/);
  // Down: a send still queues, and says which kind of down it is.
  expect((await endo(dir, "send", "--id", "queued-while-down", "what is 2+2?")).err).toMatch(/fixture is not serving: nothing runs it; `endo up`/);
  // Inception holds the lock: an `up` meanwhile refuses with the reason, and a send during it queues with the reason.
  const probe = `(cd ${dir} && ${process.execPath} ${ENDO} send --id queued-during-inception what is 2+2? 2>${join(dir, "probe.err")}; ${process.execPath} ${ENDO} up --foreground >${join(dir, "probe.up")} 2>&1; ${process.execPath} ${ENDO} status >${join(dir, "probe.status")})`;
  const second = await endo(dir, "incept", "--inceptor", `${probe}; ${process.execPath} ${join(ROOT, "test/fixtures/inceptor.ts")}`);
  expect(second.code).toBe(0);
  expect(readFileSync(join(dir, "probe.err"), "utf8")).toMatch(/fixture is not serving: inception 2 is running \(.*inceptor\.ts.*, since /);
  expect(readFileSync(join(dir, "probe.up"), "utf8")).toMatch(/inception 2 is (?:already )?running/);
  expect(readFileSync(join(dir, "probe.status"), "utf8")).toMatch(/fixture: up, incepting[\s\S]*inception 2 is running/);
  expect(readdirSync(join(dir, ".endo/workspace")).sort()).toEqual(["BASELINE", "CHANGES.md", "CLI.md", "DIFF.md", "EVOLUTION.md", "GRANT.md", "MANIFEST.md", "PROGRAM.md", "TASK.md", "batteries", "instance.json"]);
  expect(readFileSync(join(dir, ".endo/workspace/EVOLUTION.md"), "utf8")).toMatch(/nothing: no spawn/);
  expect(readFileSync(join(dir, ".endo/workspace/DIFF.md"), "utf8")).toMatch(/\+Also: be brief/);
  expect(readFileSync(join(dir, ".endo/workspace/TASK.md"), "utf8")).toMatch(/revising it, not starting over/);
  expect(readdirSync(join(dir, ".endo/snapshots")).sort()).toEqual(["1", "2"]);
  expect(readdirSync(join(dir, ".endo/inceptions/2/rounds/2")).sort()).toEqual(["CHANGES.md", "agent.ts", "instance.json", "round.json", "src", "stdout.txt"]);
  expect(existsSync(join(dir, ".endo/src/README.md"))).toBe(true);

  // The first up after inception 2 delivers the inceptor's brief as a request from inceptor:2, once.
  const again = startAgent(dir);
  try {
    await again.ready();
    let briefed: { text: string } | undefined;
    await again.waitFor("inception 2 briefing", () => {
      const s = openSqliteStore(join(dir, ".endo/agent.db"));
      try { briefed = [...allFrames(s)].filter((f) => f.type === "reply").map((f) => f.payload as { text: string }).find((r) => r.text === "seen from inceptor:2"); }
      finally { s.close(); }
      return !!briefed;
    });
    expect(briefed?.text).toBe("seen from inceptor:2");
    // What queued while down and during inception is served now.
    expect(await endo(dir, "wait", "queued-while-down")).toMatchObject({ code: 0, out: "4" });
    expect(await endo(dir, "wait", "queued-during-inception")).toMatchObject({ code: 0, out: "4" });
  } finally {
    await again.stop();
  }
  {
    const s = openSqliteStore(join(dir, ".endo/agent.db"));
    // The briefing rode in the same batch as what queued; it was delivered once.
    expect([...allFrames(s)].filter((f) => f.type === "request" && (f.payload as { metadata?: { endo?: { briefing?: number } } }).metadata?.endo?.briefing === 2).length).toBe(1);
    s.close();
  }

  // A program the load pipeline rejects (here: it throws on import) is incepted again by `endo up`, not installed blind.
  appendFileSync(join(dir, ".endo/program/agent.ts"), "\nthrow new Error('broken by an endograph change');\n");
  const third = startAgent(dir, "--inceptor", `${process.execPath} ${join(ROOT, "test/fixtures/inceptor.ts")}`);
  try {
    await third.ready();
    expect(third.output()).toMatch(/program: broken by an endograph change: running inception 3/);
    expect(JSON.parse(readFileSync(join(dir, ".endo/inceptions/3/inception.json"), "utf8"))).toMatchObject({ n: 3, outcome: "recorded" });
    expect(await endo(dir, "send", "--wait", "what is 2+2?")).toMatchObject({ code: 0, out: "4" });
    // Auto mode: the owner edits the manifest while the agent runs; it incepts by itself once idle, reloads, and is briefed.
    appendFileSync(join(dir, "manifest.md"), "\nAnd: sign off with a frog.\n");
    let briefed4: { text: string } | undefined;
    await third.waitFor("inception 4 briefing", () => {
      const s = openSqliteStore(join(dir, ".endo/agent.db"));
      try { briefed4 = [...allFrames(s)].filter((f) => f.type === "reply").map((f) => f.payload as { text: string }).find((r) => r.text === "seen from inceptor:4"); }
      finally { s.close(); }
      return !!briefed4;
    });
    expect(briefed4?.text).toBe("seen from inceptor:4");
    expect(JSON.parse(readFileSync(join(dir, ".endo/inceptions/4/inception.json"), "utf8"))).toMatchObject({ n: 4, outcome: "recorded" });
    expect(await endo(dir, "send", "--wait", "what is 2+2?")).toMatchObject({ code: 0, out: "4" });
    expect((await endo(dir, "status")).out).toMatch(/fixture: up, idle/);
  } finally {
    await third.stop();
  }

  // Reset wipes the state directory and the registration.
  expect((await endo(dir, "reset", "--force")).code).toBe(0);
  expect(existsSync(join(dir, ".endo"))).toBe(false);
  expect((await endo(dir, "--agent", "fixture", "status")).err).toMatch(/no agent "fixture"/);
}, 300000);
