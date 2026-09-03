import { existsSync } from "node:fs";
import { join } from "node:path";
import { actionResult, createAction } from "@projectors/core";
import { stringify as toToml } from "smol-toml";
import { z } from "zod";
import type { Battery } from "../agent/define.ts";
import { LateBound, type RuntimeContext } from "../agent/runtime.ts";
import { explainMiss, matchRule } from "../playbook/match.ts";
import { parseEntry } from "../playbook/parse.ts";
import { checkShellSyntax, runRule } from "../playbook/run.ts";
import type { Rule } from "../playbook/types.ts";

/**
 * The model's hands on its own experience: write a rule or a procedure (the
 * input schema is the frontmatter; the tool renders the file, checks it
 * with `sh -n`, records a playbook frame, reloads) and dry-run a rule.
 * Procedures themselves are typed tools compiled from the playbook
 * (playbook/actions.ts).
 */
export function playbook(): Battery {
  const runtime = new LateBound<RuntimeContext>();

  const write_rule = createAction({
    state: null,
    name: "write_rule",
    description:
      "Write (or overwrite) a rule: pattern → script, so the next matching " +
      "drift is handled deterministically at zero token cost. `on` is a " +
      'drift-kind glob ("request.received"), `subject` an optional subject ' +
      'glob ("request:*"), `match` an optional regex over the drift summary ' +
      "and detail. The script gets ENDO_DRIFT_* and exits 0 handled / 77 " +
      "refused / 75 in progress / other = failed, to judgment. Validated " +
      "(frontmatter, sh -n) before it is written.",
    inputSchema: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case"),
      on: z.string().min(1),
      subject: z.string().optional(),
      match: z.string().optional(),
      cooldown_s: z.number().nonnegative().optional(),
      on_failure: z.enum(["judge", "settle"]).optional(),
      script: z.string().min(1),
      notes: z.string().describe("Prose for the next reader: the diagnosis story, what the script assumes"),
    }),
    run: async ({ name, script, notes, ...meta }) => {
      const front = { kind: "rule", provenance: "agent", ...compact(meta) };
      return writeEntry(runtime.get(), name, front, notes, script);
    },
  });

  const write_procedure = createAction({
    state: null,
    name: "write_procedure",
    description:
      "Write (or overwrite) a procedure: a named, repeatable script that " +
      "becomes a tool of yours named after it, args as ENDO_ARG_<NAME>. " +
      "expose = true also makes it callable by peers (`endo call <name> " +
      "KEY=VAL`) without waking you. Validated (frontmatter, sh -n) before " +
      "it is written; available on your next activation.",
    inputSchema: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case"),
      description: z.string().min(1),
      expose: z.boolean().optional(),
      args: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.object({ required: z.boolean().optional(), description: z.string().optional() })).optional(),
      script: z.string().min(1),
      notes: z.string().describe("Prose: what it does, how to verify success, what usually goes wrong"),
    }),
    run: async ({ name, script, notes, args, ...meta }) => {
      const front: Record<string, unknown> = { kind: "procedure", provenance: "agent", ...compact(meta) };
      if (args && Object.keys(args).length) front.args = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, compact(v)]));
      return writeEntry(runtime.get(), name, front, notes, script);
    },
  });

  const try_rule = createAction({
    state: null,
    name: "try_rule",
    description:
      "Dry-run a rule against a synthetic drift: reports whether the matcher " +
      "fires, then runs the script with ENDO_DRIFT_* and ENDO_TRY=1 set. The " +
      "script runs for real — give it a drift it will reject early, or one " +
      "whose effects are safe, and honor ENDO_TRY in scripts that must not.",
    inputSchema: z.object({
      name: z.string(),
      drift: z.object({
        kind: z.string().optional().describe('default "request.received"'),
        subject: z.string().optional().describe('default "request:inc-try"'),
        summary: z.string().optional().describe('default "synthetic drift"'),
        detail: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
    run: async ({ name, drift }) => {
      const ctx = runtime.get();
      const rule = ctx.playbook().find((e): e is Rule => e.kind === "rule" && e.name === name);
      if (!rule) return actionResult({ success: false, error: `no rule "${name}"` });
      const synthetic = {
        ...drift,
        kind: drift.kind ?? "request.received",
        subject: drift.subject ?? "request:inc-try",
        summary: drift.summary ?? "synthetic drift",
        observedAt: Date.now(),
        incident: "inc-try",
      };
      const fires = matchRule([rule], synthetic) !== undefined;
      const lines = [fires ? "matcher: fires" : `matcher: does NOT fire — ${explainMiss(rule, synthetic)}`];
      if (!fires && rule.on === "request.received") {
        lines.push('NOTE: real request drifts have subject "request:<incident>" and summary "request from <principal>: <text>".');
      }
      const result = await runRule(rule, synthetic, { ...ctx.scripts, env: { ...ctx.scripts.env, ENDO_TRY: "1" } });
      lines.push(
        `script: ${result.ok ? "ok" : "FAILED"} — ${result.summary}${result.refused ? " (refused: exit 77)" : result.pending ? " (in progress: exit 75)" : ""}`,
        result.detail ?? "",
      );
      return lines.filter(Boolean).join("\n");
    },
  });

  return {
    name: "playbook",
    tools: [write_procedure, write_rule, try_rule],
    sessions: {
      learn: {
        description: "the agent reads its mandate, explores, writes procedures",
        prompt: (ask) => (ask ? `${LEARN_REPORT}\n\nThe owner adds: ${ask}` : LEARN_REPORT),
      },
    },
    bind: (ctx) => runtime.bind(ctx),
  };
}

const LEARN_REPORT = [
  `Learning session: build the procedures your mandate needs.`,
  ``,
  `Read your mandate (above). Explore the working directory with bash —`,
  `README, CLAUDE.md / AGENTS.md, Makefile, package.json scripts, scripts/ —`,
  `read-only: do not start long-running processes or change anything.`,
  `Work out what you need to know to fulfil the mission: how to build,`,
  `deploy, run, check, or tend whatever your mandate puts in your care,`,
  `and what usually goes wrong.`,
  ``,
  `Write what you learn with write_procedure: one named, repeatable`,
  `operation each. Arguments arrive as ENDO_ARG_<NAME> env vars; the prose`,
  `explains what it does, how to verify success, and what usually goes`,
  `wrong. Each becomes a tool of yours named after it. Keep them small and`,
  `composable (build, deploy, check) rather than one monolith. Mark the`,
  `ones peers will want to call directly with expose = true. Write rules`,
  `(write_rule) only where a deterministic response is already obvious.`,
  ``,
  `Set world model entries (world tool) for what you now know — targets,`,
  `hosts, what is installed where — so future activations start informed.`,
  `Close with resolve listing the entries written, or escalate if the`,
  `mandate cannot be fulfilled from this repository.`,
].join("\n");

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Render, validate, write, record, reload. */
async function writeEntry(ctx: RuntimeContext, name: string, front: Record<string, unknown>, notes: string, script: string) {
  const content = `+++\n${toToml(front).trim()}\n+++\n\n${notes.trim()}\n\n\`\`\`sh\n${script.trim()}\n\`\`\`\n`;
  const existing = ctx.playbook().find((e) => e.name === name);
  const path = existing?.file ?? join(ctx.home.srcDir, `${name}.md`);
  try {
    parseEntry(path, content);
  } catch (err) {
    return actionResult({ success: false, error: `entry does not parse — not written: ${err instanceof Error ? err.message : err}` });
  }
  const syntax = await checkShellSyntax(script);
  if (syntax) return actionResult({ success: false, error: `script does not parse (sh -n) — not written: ${syntax}` });
  const replaced = existsSync(path);
  await Bun.write(path, content);
  await ctx.reloadPlaybook();
  // The one thing a high-trust owner wants to glance at: the agent changed its own rules.
  ctx.record({
    type: "playbook",
    subject: `playbook:${name}`,
    summary: `${replaced ? "rewrote" : "wrote"} ${name} (${front.kind}, ${content.length} bytes)`,
    payload: { file: path, kind: front.kind, replaced, bytes: content.length },
  });
  return `${replaced ? "rewrote" : "wrote"} ${path} and reloaded the playbook`;
}
