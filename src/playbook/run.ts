import { spawn } from "node:child_process";
import type { Drift, Outcome } from "../loop/types.ts";
import type { Procedure, Rule } from "./types.ts";

/**
 * Exit-code contract (sysexits.h): 0 handled, 75 EX_TEMPFAIL in progress
 * (a background job finishes and answers later), 77 EX_NOPERM refused
 * (deterministic policy: settle not-ok, never judge). Anything else is a
 * failure and falls to judgment when the rule says so.
 */
export const IN_PROGRESS_EXIT = 75;
export const REFUSED_EXIT = 77;

/** Where scripts run and what they see. */
export interface ScriptContext {
  /** Working directory for scripts and bash (the declaration's `cwd`). */
  cwd: string;
  /** The agent's home; ENDO_HOME. */
  home: string;
  /** agent/src; ENDO_SRC. */
  src: string;
  env?: Record<string, string>;
}

export function scriptEnv(ctx: ScriptContext, extra: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    ENDO_HOME: ctx.home,
    ENDO_SRC: ctx.src,
    ENDO_CWD: ctx.cwd,
    ...ctx.env,
    ...extra,
  };
}

/**
 * The one place scripts run. The child leads its own process group so a
 * timeout kills the whole tree (a `make` under a `sh`), not just the shell.
 */
export function runShell(
  script: string,
  ctx: ScriptContext,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number; tailLines?: number; what?: string } = {},
): Promise<Outcome & { code: number }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", script], {
      cwd: ctx.cwd,
      env: scriptEnv(ctx, opts.env) as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeoutMs ?? 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, ...scriptOutcome(opts.what ?? "script", 127, stdout, `${stderr}\n${err.message}`, opts.tailLines ?? 40) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exit = code ?? 128;
      if (timedOut) stderr += `\n${opts.what ?? "script"} timed out after ${(opts.timeoutMs ?? 120_000) / 1000}s (${signal ?? "killed"})`;
      resolve({ code: exit, ...scriptOutcome(opts.what ?? "script", exit, stdout, stderr, opts.tailLines ?? 40) });
    });
  });
}

/**
 * A script's account of itself: on success its last stdout line is the
 * summary (what a rule prints last is what the requester reads); on
 * failure the exit code is, with the output tail as evidence either way.
 */
export function scriptOutcome(what: string, code: number, stdout: string, stderr: string, tailLines: number): Outcome {
  const output = (stdout + stderr).trim();
  const tail = output.split("\n").slice(-tailLines).join("\n") || undefined;
  const lastLine =
    stdout.trim().split("\n").filter(Boolean).pop() ?? stderr.trim().split("\n").filter(Boolean).pop();
  if (code === IN_PROGRESS_EXIT) return { ok: true, summary: lastLine ?? `${what} in progress`, detail: tail, pending: true };
  if (code === REFUSED_EXIT) return { ok: false, summary: lastLine ?? `${what} refused`, detail: tail, refused: true };
  return { ok: code === 0, summary: code === 0 ? (lastLine ?? `${what} exited 0`) : `${what} exited ${code}`, detail: tail };
}

export async function runRule(rule: Rule, drift: Drift, ctx: ScriptContext, opts: { timeoutMs?: number } = {}): Promise<Outcome> {
  const { code: _code, ...outcome } = await runShell(rule.script, ctx, {
    what: `rule ${rule.name}`,
    timeoutMs: opts.timeoutMs,
    env: {
      ENDO_DRIFT_KIND: drift.kind,
      ENDO_DRIFT_SUBJECT: drift.subject,
      ENDO_DRIFT_SUMMARY: drift.summary,
      ENDO_DRIFT_DATA: JSON.stringify(drift.data ?? {}),
      ...(drift.incident ? { ENDO_DRIFT_INCIDENT: drift.incident } : {}),
    },
  });
  return outcome;
}

/** Validate call/procedure args against the spec: unknown or missing names are errors. */
export function validateArgs(procedure: Procedure, args: Record<string, string>): string | null {
  const problems: string[] = [];
  for (const key of Object.keys(args)) if (!(key in procedure.args)) problems.push(`unknown arg ${key}`);
  for (const [key, spec] of Object.entries(procedure.args)) {
    if (spec.required && !(key in args)) problems.push(`missing required arg ${key}`);
  }
  return problems.length ? problems.join("; ") : null;
}

export async function runProcedure(
  procedure: Procedure,
  args: Record<string, string>,
  ctx: ScriptContext,
  opts: { timeoutMs?: number } = {},
): Promise<Outcome> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) env[`ENDO_ARG_${key}`] = value;
  const { code: _code, ...outcome } = await runShell(procedure.script, ctx, {
    what: `procedure ${procedure.name}`,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    tailLines: 80,
    env,
  });
  return outcome;
}

/** `sh -n` on a script: the shell's complaint, or null when it parses. */
export async function checkShellSyntax(script: string): Promise<string | null> {
  const child = Bun.spawn(["sh", "-n"], { stdin: new Blob([script]), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text()]);
  return code === 0 ? null : stderr.trim() || `sh -n exited ${code}`;
}
