import { basename, join } from "node:path";
import { actionResult, createAction, type AnyAction } from "@projectors/core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { globMatch, matchRule } from "../playbook/match.ts";
import { parseEntry } from "../playbook/parse.ts";
import { runProcedure, runRule } from "../playbook/run.ts";
import type { JudgeRuntime } from "./runtime.ts";

/**
 * The judgment layer's tool grant, as projector actions. Every call and
 * result lands in the frame log via the executor's action invocation path —
 * full attribution, replayable.
 *
 * Two terminal actions end an activation: `resolve` (diagnosis + what was
 * done) and `escalate` (needs a human). The model must close with one.
 */
export function buildJudgeActions(
  runtime: JudgeRuntime,
  opts: { supervises?: boolean } = {},
): AnyAction[] {
  const process = createAction({
    state: null,
    name: "process",
    description:
      "Operate a supervised process from the world model. " +
      "Ops: start, stop, restart (with backoff), logs (last 100 lines).",
    inputSchema: z.object({
      op: z.enum(["start", "stop", "restart", "logs"]),
      name: z.string().describe('Process name, e.g. "metro"'),
    }),
    run: async ({ op, name }) => {
      const verb = runtime.get().verbs.get(op);
      if (!verb) return `unknown op "${op}"`;
      const result = await verb.run(`process:${name}`);
      return [
        `${result.ok ? "ok" : "FAILED"}: ${result.summary}`,
        result.detail ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const bash = createAction({
    state: null,
    name: "bash",
    description:
      "Run a shell command in the project directory (full-exec grant). " +
      "Use for diagnosis (read files, check hosts/ports/processes) and for " +
      "repairs. Long operations (builds, deploys) are fine: set timeout_s.",
    inputSchema: z.object({
      cmd: z.string(),
      timeout_s: z.number().positive().max(3600).optional(),
    }),
    run: async ({ cmd, timeout_s }) => {
      const { projectDir } = runtime.get();
      const child = Bun.spawn(["sh", "-c", cmd], {
        cwd: projectDir,
        env: process_env(),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), (timeout_s ?? 120) * 1000);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
      ]);
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      const tail = output.split("\n").slice(-80).join("\n");
      return `exit ${code}\n${tail}`;
    },
  });

  const runProcedureAction = createAction({
    state: null,
    name: "run_procedure",
    description:
      "Run a script procedure from your playbook (src/playbook/<name>.md) " +
      "in the project directory. Args become ENDO_ARG_<NAME> env vars. " +
      "Returns the exit code and output tail.",
    inputSchema: z.object({
      name: z.string().describe("Procedure name (filename stem)"),
      args: z.record(z.string(), z.string()).optional(),
      timeout_s: z.number().positive().max(3600).optional(),
    }),
    run: async ({ name, args, timeout_s }) => {
      const ctx = runtime.get();
      const procedure = ctx
        .playbook()
        .find((e) => e.kind === "procedure" && e.name === name);
      if (!procedure || procedure.kind !== "procedure") {
        const known = ctx
          .playbook()
          .filter((e) => e.kind === "procedure" && e.script)
          .map((e) => e.name);
        return actionResult({
          success: false,
          error: `no procedure "${name}"${known.length ? ` — known: ${known.join(", ")}` : ""}`,
        });
      }
      const result = await runProcedure(procedure, args ?? {}, {
        projectDir: ctx.projectDir,
        agentDir: ctx.agentDir,
        timeoutMs: timeout_s ? timeout_s * 1000 : undefined,
      });
      return [
        `${result.ok ? "ok" : "FAILED"}: ${result.summary}`,
        result.detail ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const writePlaybookEntry = createAction({
    state: null,
    name: "write_playbook_entry",
    description:
      "Write a playbook entry into the agent's src/playbook/. Rules make " +
      "the next occurrence deterministic, instant, and free; procedures " +
      "are named scripts you can run_procedure later. Format: TOML " +
      "frontmatter between +++ fences (rule: kind, on = drift kind glob, " +
      "subject? = glob over the drift subject such as \"request:*\" or " +
      "\"process:api\" (omit it to match any), match? = regex over the drift " +
      "summary+detail, provenance, cooldown_s, on_failure?; procedure: kind/provenance and, " +
      "for process supervision only, [[process]] tables), then a prose " +
      "body; the script goes in the body's first ```sh fenced block. A " +
      "rule may name `verb` ONLY when it is one of the process verbs " +
      "(start/stop/restart/logs) of a supervising agent — otherwise omit " +
      "it and use a script. Overwrites an existing entry of the same name. " +
      "The entry is validated before it is written.",
    inputSchema: z.object({
      filename: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*\.md$/, "kebab-case .md filename"),
      content: z.string(),
    }),
    run: async ({ filename, content }) => {
      const { playbookDir, onPlaybookChanged, record } = runtime.get();
      const path = join(playbookDir, basename(filename));
      let entry;
      try {
        entry = parseEntry(path, content);
      } catch (err) {
        return actionResult({
          success: false,
          error: `entry does not parse — not written: ${err instanceof Error ? err.message : err}`,
        });
      }
      const script = entry.kind === "rule" ? entry.script : entry.script;
      if (script) {
        const syntax = await checkShellSyntax(script);
        if (syntax) {
          return actionResult({
            success: false,
            error: `script does not parse (sh -n) — not written: ${syntax}`,
          });
        }
      }
      const replaced = existsSync(path);
      await Bun.write(path, content);
      await onPlaybookChanged();
      // The one thing a high-trust owner wants to glance at: the agent
      // changed its own rules. A frame of its own, not just a tool call.
      record({
        type: "playbook",
        subject: `playbook:${entry.name}`,
        summary: `${replaced ? "rewrote" : "wrote"} ${entry.name} (${entry.kind}, ${content.length} bytes)`,
        payload: { file: path, kind: entry.kind, replaced, bytes: content.length },
      });
      return `${replaced ? "rewrote" : "wrote"} ${path} and reloaded the playbook`;
    },
  });

  const tryRule = createAction({
    state: null,
    name: "try_rule",
    description:
      "Dry-run a rule against a synthetic drift before trusting it: reports " +
      "whether the rule's matcher fires, then runs its script with the " +
      "synthetic drift in ENDO_DRIFT_* and ENDO_TRY=1 set, returning the " +
      "exit status and output. The script runs for real — give it a drift " +
      "it will reject early (a bogus path, an unknown host) or one whose " +
      "effects are safe, and honor ENDO_TRY in scripts that must not.",
    inputSchema: z.object({
      name: z.string().describe("Rule name (filename stem)"),
      drift: z.object({
        kind: z.string().default("request.received"),
        subject: z.string().default("request:inc-try"),
        summary: z.string().default("synthetic drift"),
        detail: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
    run: async ({ name, drift }) => {
      const ctx = runtime.get();
      const rule = ctx.playbook().find((e) => e.kind === "rule" && e.name === name);
      if (!rule || rule.kind !== "rule") {
        return actionResult({ success: false, error: `no rule "${name}"` });
      }
      const synthetic = { ...drift, observedAt: Date.now(), incident: "inc-try" };
      const matched = matchRule([rule], synthetic);
      const lines = [matched ? `matcher: fires` : `matcher: does NOT fire — ${explainMiss(rule, synthetic)}`];
      if (!matched && rule.on === "request.received") {
        lines.push(
          `NOTE: real request drifts have subject "request:<incident>" and summary ` +
            `"request from <path>: <text>" (or "N requests pending from …"). A rule ` +
            `that does not fire for those handles nothing.`,
        );
      }
      // `process` is the action above; the runtime's is on globalThis.
      const env = globalThis.process.env;
      const previous = env.ENDO_TRY;
      env.ENDO_TRY = "1";
      try {
        const result = await runRule(rule, synthetic, {
          projectDir: ctx.projectDir,
          agentDir: ctx.agentDir,
          verbs: ctx.verbs,
        });
        lines.push(
          `script: ${result.ok ? "ok" : "FAILED"} — ${result.summary}` +
            (result.refused ? " (refused: exit 64)" : result.pending ? " (in progress: exit 75)" : ""),
          result.detail ?? "",
        );
      } finally {
        if (previous === undefined) delete env.ENDO_TRY;
        else env.ENDO_TRY = previous;
      }
      return lines.filter(Boolean).join("\n");
    },
  });

  const world = createAction({
    state: null,
    name: "world",
    description:
      "Maintain your world model — the converged picture of what you tend " +
      "(targets, hosts, what is installed where, what was last requested). " +
      "It is projected into every activation and shown by `endo status`. " +
      "op=set writes an entry (subject like \"target:stout\"); op=clear removes it.",
    inputSchema: z.object({
      op: z.enum(["set", "clear"]),
      subject: z.string().min(1),
      kind: z.string().optional().describe('Entry kind, e.g. "target", "host"'),
      state: z.enum(["green", "yellow", "red", "gray"]).optional(),
      summary: z.string().optional().describe("One line, human-readable"),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
    run: ({ op, subject, kind, state, summary, data }) => {
      const { record } = runtime.get();
      if (op === "clear") {
        record({ type: "world", subject, summary: `cleared ${subject}` }, { [subject]: null });
        return `cleared ${subject}`;
      }
      record(
        { type: "world", subject, summary: `${subject}: ${summary ?? "(updated)"}` },
        {
          [subject]: {
            kind: kind ?? subject.split(":")[0] ?? "entry",
            state: state ?? "gray",
            summary: summary ?? "",
            data: data ?? {},
            updatedAt: Date.now(),
          },
        },
      );
      return `set ${subject}`;
    },
  });

  const reply = createAction({
    state: null,
    name: "reply",
    description:
      "Answer a peer's request by its incident id. ok=true when the request " +
      "was fulfilled (or needs nothing), false when it was refused, " +
      "superseded, or failed — say why. Each request can be answered once; " +
      "any request you leave unanswered is answered with your resolution.",
    inputSchema: z.object({
      to: z.string().describe("The request's incident id, e.g. inc-1a2b3c4d"),
      ok: z.boolean(),
      text: z.string(),
    }),
    run: ({ to, ok, text }) => {
      const { inbox } = runtime.get();
      if (!inbox) {
        return actionResult({ success: false, error: "no inbox in this session" });
      }
      return inbox.reply(to, ok, text)
        ? `replied to ${to}`
        : actionResult({
            success: false,
            error: `${to} is not awaiting a reply (unknown or already answered)`,
          });
    },
  });

  const compact = createAction({
    state: null,
    name: "compact",
    description:
      "Replace your visible history with a summary of it. Everything before " +
      "stays in the frame log (endo why/replay), but your next activation " +
      "sees only this summary plus frames after it. Write what a successor " +
      "needs and cannot get elsewhere: what you tend and its current state, " +
      "what peers ask and how you handle it, open requests and unfinished " +
      "work, lessons and pitfalls. Do NOT restate your charter, tools, or " +
      "playbook — those are always present and this copy would go stale. " +
      "Takes effect when this activation ends.",
    inputSchema: z.object({ summary: z.string().min(1) }),
    run: ({ summary }) => {
      runtime.requestCompaction(summary);
      return "compaction queued; it applies when this activation ends";
    },
  });

  const resolve = createAction({
    state: null,
    name: "resolve",
    description:
      "End the activation: the drift is handled (or benign). Give the " +
      "diagnosis and what was done. Call exactly one of resolve/escalate.",
    inputSchema: z.object({
      diagnosis: z.string(),
      action_taken: z.string(),
    }),
    run: ({ diagnosis, action_taken }) =>
      actionResult({
        value: `resolved: ${diagnosis} — ${action_taken}`,
        terminal: true,
      }),
  });

  const escalate = createAction({
    state: null,
    name: "escalate",
    description:
      "End the activation: a human is needed. Summarize the situation, " +
      "what you tried, and what you recommend. Call exactly one of " +
      "resolve/escalate.",
    inputSchema: z.object({
      summary: z.string(),
      recommendation: z.string().optional(),
    }),
    run: ({ summary, recommendation }) =>
      actionResult({
        value: `escalate: ${summary}${recommendation ? ` — recommend: ${recommendation}` : ""}`,
        terminal: true,
      }),
  });

  return [
    ...(opts.supervises ? [process] : []),
    bash,
    runProcedureAction,
    writePlaybookEntry,
    tryRule,
    world,
    reply,
    compact,
    resolve,
    escalate,
  ];
}

function explainMiss(
  rule: { on: string; subject?: string; match?: RegExp },
  drift: { kind: string; subject: string; summary: string; detail?: string },
): string {
  if (!globMatch(rule.on, drift.kind)) return `on = "${rule.on}" does not match kind "${drift.kind}"`;
  if (rule.subject && !globMatch(rule.subject, drift.subject)) {
    return `subject = "${rule.subject}" does not match subject "${drift.subject}" (it is a glob over the drift subject, e.g. "request:*" or "process:api")`;
  }
  if (rule.match) {
    return `match = /${rule.match.source}/ does not match "${drift.summary}"${drift.detail ? " or its detail" : ""}`;
  }
  return "unknown reason";
}

/** `sh -n` on a script; the shell's complaint, or null when it parses. */
async function checkShellSyntax(script: string): Promise<string | null> {
  const child = Bun.spawn(["sh", "-n"], { stdin: new Blob([script]), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text()]);
  return code === 0 ? null : stderr.trim() || `sh -n exited ${code}`;
}

function process_env(): Record<string, string | undefined> {
  return { ...process.env, FORCE_COLOR: "0" };
}
