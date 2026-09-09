import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAgent, whyNotServing } from "../src/harness/inspect.ts";
import { acquireLock } from "../src/harness/lock.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { HOST, writeLoadFailure } from "../src/harness/residence.ts";
import { hashOf, hashText } from "../src/inception/incept.ts";
import { readObservatorySnapshot } from "../src/observatory/data.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";

test("CLI and observatory share inception, residence and failure observations without loading code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-inspect-"));
  const paths = pathsOf(dir);
  ensureStateDir(paths);
  mkdirSync(join(paths.state, "program"), { recursive: true });
  writeFileSync(paths.program, 'throw new Error("inspection must not import this program");');
  writeFileSync(paths.grant, 'name="inspection"\n[manifest]\ntext="""\nOwner intent\n"""\n[executor]\nprovider="openai"\nmodel="unused"\n');
  const version = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version;
  const store = openSqliteStore(paths.db);
  store.append({ type: "inception", summary: "initial", at: 1, payload: {
    n: 1, manifest: hashText("Owner intent\n"), grant: hashOf(paths.grant), program: hashOf(paths.program), version,
  } });
  store.close();
  const lock = acquireLock(paths.lock)!;
  const status = { name: "inspection", host: HOST, at: Date.now(), running: true, active: false, open: [], runs: [] };
  const write = (fields: object = {}) => writeFileSync(paths.status, JSON.stringify({ ...status, ...fields }));
  const attemptDir = join(paths.inceptions, "2");
  const started = new Date(status.at + 1).toISOString();
  const attempt = { n: 2, inceptor: "manual", started };
  try {
    write();
    expect(await inspectAgent(paths)).toMatchObject({ phase: "idle", reason: null, inputError: null, inception: { changed: [] } });
    write({ active: true });
    expect((await readObservatorySnapshot(paths)).agent.phase).toBe("active");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, "inception.json"), JSON.stringify(attempt));
    write({ incepting: 2 });
    const inspection = await inspectAgent(paths);
    expect(inspection.phase).toBe("incepting");
    expect(await whyNotServing(paths, "inspection")).toBe(inspection.reason);
    expect((await readObservatorySnapshot(paths)).agent).toMatchObject({ phase: inspection.phase, reason: inspection.reason, active: false });
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/index.ts"), "--agent", dir, "status"], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("inspection: up, incepting");
    expect(out).toContain(inspection.reason!);
    // A newer running worker makes an interrupted attempt's record stale.
    write({ at: status.at + 2 });
    expect((await inspectAgent(paths)).phase).toBe("idle");
    write({ host: "another-host" });
    expect(await inspectAgent(paths)).toMatchObject({ phase: "down", reason: expect.stringContaining("held by another-host") });
    writeFileSync(join(attemptDir, "inception.json"), JSON.stringify({ ...attempt, finished: started }));
  } finally { lock.release(); }
  try {
    write(); // Stale running=true is not evidence of a live worker without its lock.
    expect((await inspectAgent(paths)).phase).toBe("down");
    writeLoadFailure(paths, { stage: "program", error: "broken program", program: hashOf(paths.program), at: Date.now() });
    expect((await readObservatorySnapshot(paths)).inception.loadError).toBe("broken program");
    writeFileSync(paths.program, "// repaired");
    expect((await inspectAgent(paths)).failure).toBeNull();
    writeFileSync(paths.grant, "invalid TOML [");
    expect((await readObservatorySnapshot(paths)).inception.inputError).toBeTruthy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
