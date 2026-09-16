import { createAction, type AnyAction } from "@projectors/core";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Battery } from "../grant/grant.ts";

declare module "../program/define.ts" {
  interface GrantedActions {
    bash: AnyAction;
  }
}

/**
 * The one place shell runs. The child leads its own process group so a
 * timeout kills the whole tree (a `make` under a `sh`), not just the shell.
 */

export interface ShellResult {
  code: number;
  /** The last `tailLines` of stdout and stderr, in arrival order. */
  output: string;
  timedOut: boolean;
}

export interface ShellOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  tailLines?: number;
}

export function runShell(script: string, opts: ShellOptions): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const tailLines = opts.tailLines ?? 40;
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", script], {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: "0", ...opts.env } as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    const finish = (code: number, note?: string) => {
      clearTimeout(timer);
      if (note) output += `\n${note}`;
      resolve({ code, output: output.trim().split("\n").slice(-tailLines).join("\n"), timedOut });
    };
    child.on("error", (err) => finish(127, err.message));
    child.on("close", (code, signal) =>
      finish(code ?? 128, timedOut ? `timed out after ${timeoutMs / 1000}s (${signal ?? "killed"})` : undefined),
    );
  });
}

/**
 * The bash battery: one action, a shell in the grant's `cwd`. The agent can
 * do what its user can; the sandbox, when it lands, wraps the whole process.
 */
export function bash(): Battery {
  return {
    name: "bash",
    guide: GUIDE,
    actions: ({ cwd }) => [
      createAction({
        state: null,
        name: "bash",
        description:
          "Run a shell command in the working directory. Long operations (builds, " +
          "deploys) are fine: set timeout_s. You see the last 80 lines of output.",
        inputSchema: z.object({ cmd: z.string(), timeout_s: z.number().positive().max(3600).optional() }),
        run: async ({ cmd, timeout_s }) => {
          const result = await runShell(cmd, { cwd, timeoutMs: (timeout_s ?? 120) * 1000, tailLines: 80 });
          return `exit ${result.code}\n${result.output}`.trimEnd();
        },
      }),
    ],
  };
}

const GUIDE = `# bash

One action, \`bash({ cmd, timeout_s? })\`: a shell in the grant's \`cwd\`
with the agent's own environment. Output is the exit code and the last 80
lines of stdout and stderr; a timeout (default 120 s, at most an hour)
kills the whole process tree.

Commands can read and write files and invoke installed tools within the
process sandbox. Procedures are also available for named, callable work
(PROGRAM.md §6.5).
`;
