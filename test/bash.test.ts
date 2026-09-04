import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runShell } from "../src/batteries/bash.ts";

test("exit code and output tail come back; a timeout kills the whole process tree", async () => {
  const ok = await runShell("seq 1 5; echo err >&2; exit 3", { cwd: tmpdir(), tailLines: 3 });
  expect(ok).toEqual({ code: 3, output: "4\n5\nerr", timedOut: false });

  const result = await runShell("sleep 300 & echo child=$!; wait", { cwd: tmpdir(), timeoutMs: 300 });
  const pid = Number(result.output.match(/child=(\d+)/)?.[1]);
  expect(result.timedOut).toBe(true);
  expect(result.output).toMatch(/timed out/);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});
