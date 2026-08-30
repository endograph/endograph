import type { Drift, Verb, VerbResult } from "../core/types.ts";
import type { PlaybookRule, Procedure } from "./types.ts";

/**
 * A script that exits with this status is REFUSING, deterministically: the
 * drift settles not-ok with the script's last stdout line, and the judgment
 * layer is not consulted. Any other non-zero status is a failure.
 */
export const REFUSED_EXIT_STATUS = 64;
/**
 * A script that exits with this status has STARTED the work and will
 * finish it in the background (a job it spawned): the drift is not settled;
 * the job answers the request later with `endo reply <incident>`.
 */
export const IN_PROGRESS_EXIT_STATUS = 75;

export interface RuleRunContext {
  /** Project directory; scripts run here under the granted shell. */
  projectDir: string;
  agentDir: string;
  /** World-model verbs available to rules (the ergonomic safe path). */
  verbs: Map<string, Verb>;
  timeoutMs?: number;
}

/**
 * Execute a rule's response against the drift that matched it. Verb first
 * (if declared), then script. Scripts run under the same shell the agent
 * was granted — writing a rule never escalates privilege.
 */
export async function runRule(
  rule: PlaybookRule,
  drift: Drift,
  ctx: RuleRunContext,
): Promise<VerbResult> {
  if (rule.verb) {
    const verb = ctx.verbs.get(rule.verb);
    if (!verb) {
      return { ok: false, summary: `rule ${rule.name}: unknown verb "${rule.verb}"` };
    }
    const result = await verb.run(drift.subject);
    if (!result.ok || !rule.script) return result;
  }
  if (!rule.script) {
    return { ok: true, summary: `rule ${rule.name}: verb completed` };
  }
  return runScript(rule.script, drift, ctx);
}

async function runScript(
  script: string,
  drift: Drift,
  ctx: RuleRunContext,
): Promise<VerbResult> {
  const timeoutMs = ctx.timeoutMs ?? 120_000;
  const child = Bun.spawn(["sh", "-c", script], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      ENDO_DRIFT_KIND: drift.kind,
      ENDO_DRIFT_SUBJECT: drift.subject,
      ENDO_DRIFT_SUMMARY: drift.summary,
      ENDO_DRIFT_DATA: JSON.stringify(drift.data ?? {}),
      ...(drift.incident ? { ENDO_DRIFT_INCIDENT: drift.incident } : {}),
      ENDO_AGENT_DIR: ctx.agentDir,
      ENDO_PLAYBOOK_DIR: `${ctx.agentDir}/src/playbook`,
      ENDO_PROJECT_DIR: ctx.projectDir,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
  ]);
  clearTimeout(timer);
  return scriptResult("script", code, stdout, stderr, 20);
}

/**
 * A script's account of itself: on success its last stdout line is the
 * summary (what a rule prints last is what the requester reads); on
 * failure the exit code is, with the output tail as evidence either way.
 */
export function scriptResult(
  what: string,
  code: number,
  stdout: string,
  stderr: string,
  tailLines: number,
): VerbResult {
  const output = (stdout + stderr).trim();
  const tail = output.split("\n").slice(-tailLines).join("\n");
  // What the script said last: stdout by preference, stderr when that is
  // all it wrote (refusals and errors usually go there).
  const lastLine =
    stdout.trim().split("\n").filter(Boolean).pop() ??
    stderr.trim().split("\n").filter(Boolean).pop();
  if (code === IN_PROGRESS_EXIT_STATUS) {
    return { ok: true, summary: lastLine ?? `${what} in progress`, detail: tail || undefined, pending: true };
  }
  if (code === REFUSED_EXIT_STATUS) {
    return { ok: false, summary: lastLine ?? `${what} refused`, detail: tail || undefined, refused: true };
  }
  return {
    ok: code === 0,
    summary: code === 0 ? lastLine ?? `${what} exited 0` : `${what} exited ${code}`,
    detail: tail || undefined,
  };
}

/**
 * Run a script procedure with named arguments as ENDO_ARG_<NAME> env vars.
 * Same shell grant as rules; the full output tail comes back for judgment.
 */
export async function runProcedure(
  procedure: Procedure,
  args: Record<string, string>,
  ctx: { projectDir: string; agentDir: string; timeoutMs?: number },
): Promise<VerbResult> {
  if (!procedure.script) {
    return { ok: false, summary: `procedure ${procedure.name} has no script` };
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    ENDO_AGENT_DIR: ctx.agentDir,
    ENDO_PLAYBOOK_DIR: `${ctx.agentDir}/src/playbook`,
    ENDO_PROJECT_DIR: ctx.projectDir,
  };
  for (const [key, value] of Object.entries(args)) {
    env[`ENDO_ARG_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = value;
  }
  const timeoutMs = ctx.timeoutMs ?? 30 * 60 * 1000;
  const child = Bun.spawn(["sh", "-c", procedure.script], {
    cwd: ctx.projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
  ]);
  clearTimeout(timer);
  return scriptResult(`procedure ${procedure.name}`, code, stdout, stderr, 80);
}
