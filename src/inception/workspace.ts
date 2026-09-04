import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSchema, type AnyAction } from "@projectors/core";
import type { Grant } from "../grant/define.ts";
import type { Paths } from "../harness/paths.ts";
import { CONSUMER_DOC } from "../cli/usage.ts";

/**
 * `.endo/workspace/`: what the inceptor reads. The manifest, the provisions
 * as text, the program contract shipped with endograph, a guide per
 * battery, and TASK.md. Rendered fresh for every inception.
 */

const PROGRAM_DOC = resolve(import.meta.dir, "../../docs/program.md");

export interface WorkspaceInput {
  paths: Paths;
  grant: Grant;
  /** Core, battery, and pass-through actions, as the harness would build them. */
  actions: AnyAction[];
  /** This inception's number. */
  n: number;
  version: string;
  /** From inception 2 on: what the last inception left, what changed since, and where the agent stands. */
  baseline?: {
    /** snapshots/<n-1> */
    dir: string;
    /** Owner inputs then versus now, as a unified diff; empty when nothing changed. */
    diff: string;
    /** Why the current program no longer loads, if it does not. */
    errors?: string;
    /** The persisted instance, serialized. */
    instance?: unknown;
  };
}

export function renderWorkspace(input: WorkspaceInput): string {
  const { paths, grant } = input;
  const dir = paths.workspace;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "batteries"), { recursive: true });
  writeFileSync(join(dir, "MANIFEST.md"), readFileSync(resolve(paths.agentDir, grant.manifest), "utf8"));
  writeFileSync(join(dir, "GRANT.md"), renderGrant(input));
  writeFileSync(join(dir, "PROGRAM.md"), readFileSync(PROGRAM_DOC, "utf8"));
  writeFileSync(join(dir, "CLI.md"), CONSUMER_DOC);
  for (const b of grant.batteries) writeFileSync(join(dir, "batteries", `${b.name}.md`), b.guide);
  if (input.baseline) {
    const { baseline } = input;
    mkdirSync(join(dir, "BASELINE"), { recursive: true });
    cpSync(join(baseline.dir, "agent.ts"), join(dir, "BASELINE", "agent.ts"));
    if (existsSync(join(baseline.dir, "src"))) cpSync(join(baseline.dir, "src"), join(dir, "BASELINE", "src"), { recursive: true });
    writeFileSync(join(dir, "DIFF.md"), `# DIFF: owner inputs at inception ${input.n - 1} versus now\n\n${baseline.diff.trim() ? "```diff\n" + baseline.diff.trimEnd() + "\n```" : "(no change to manifest.md, endograph.ts, or the endograph version)"}\n`);
    if (baseline.errors) writeFileSync(join(dir, "ERRORS.md"), `# ERRORS: the current program does not load\n\n${baseline.errors}\n`);
    if (baseline.instance !== undefined) writeFileSync(join(dir, "instance.json"), `${JSON.stringify(baseline.instance, null, 2)}\n`);
  }
  writeFileSync(join(dir, "TASK.md"), renderTask(input));
  return dir;
}

export function renderGrant({ grant, actions, version }: WorkspaceInput): string {
  const lines: string[] = [
    `# GRANT: ${grant.name}`,
    "",
    "Everything this agent may ever do. Written from `endograph.ts`; you cannot widen it.",
    "",
    `- name: \`${grant.name}\``,
    `- executor: ${grant.executor.description ?? "(custom)"}${grant.executor.executorConfig ? ` with executorConfig ${JSON.stringify(grant.executor.executorConfig)}` : ""}`,
    `- cwd (where procedures and bash run): \`${grant.cwd}\` relative to the agent directory`,
    `- batteries: ${grant.batteries.length ? grant.batteries.map((b) => `\`${b.name}\``).join(", ") : "(none)"}`,
    `- endograph ${version}`,
    "",
    "## Actions (`endo.actions.<name>`)",
    "",
  ];
  for (const a of actions) {
    lines.push(`### ${a.name}`, "", a.description ?? "(no description)", "");
    if (a.inputSchema) lines.push("```json", JSON.stringify(normalizeSchema(a.inputSchema).jsonSchema(), null, 2), "```", "");
  }
  lines.push("## States (`endo.states.<key>`)", "");
  if (grant.states.length === 0) lines.push("(none granted; declare your own with `createState` on the nodes that use them)", "");
  for (const s of grant.states) {
    lines.push(`### ${s.key}`, "", "```json", JSON.stringify(normalizeSchema(s.schema).jsonSchema(), null, 2), "```", "");
  }
  lines.push(
    "## Procedure options",
    "",
    "`procedure({ description, expose?, args?, ...fields })`: `description` (string, required), `expose` (boolean; peers may `endo call` it), `args` (an object of Standard Schemas, one per arg; `z` from `endograph`).",
    "",
  );
  for (const b of grant.batteries) {
    for (const [field, def] of Object.entries(b.procedure?.fields ?? {})) {
      lines.push(`- \`${field}\` (${b.name}): ${def.description}`, "  ```json", `  ${JSON.stringify(normalizeSchema(def.schema).jsonSchema())}`, "  ```");
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderTask({ paths, grant, n, baseline }: WorkspaceInput): string {
  const first = n === 1;
  const revising = baseline
    ? `
This agent exists: you are revising it, not starting over (PROGRAM.md §9).
Beside this file: \`BASELINE/\` (the program and src as inception ${n - 1}
left them), \`DIFF.md\` (the owner's inputs then versus now)${baseline.errors ? `,
\`ERRORS.md\` (why the current program no longer loads: fix that first)` : ""}${baseline.instance !== undefined ? `,
and \`instance.json\` (the persisted instance; leave it alone unless the new
program cannot hydrate it, then change the minimum)` : ""}. The current
program and src are in place under \`.endo/\`; the agent's own procedures
and notes are preserved unless the new intent forbids them.
`
    : "";
  return `# TASK: inception ${n} of ${grant.name}

You are writing ${first ? "the first program" : `program ${n}`} for the agent in this directory. Work here, in the
agent directory; the files you read and write are under \`.endo/\`.
${revising}
Read, in this order: \`PROGRAM.md\` (the contract and the idioms; all of
it), \`MANIFEST.md\` (what this agent is for), \`GRANT.md\` (what it may
do), \`CLI.md\` (how peers reach it: the only source of truth for what
the agent may tell peers to type), and every guide under \`batteries/\`.

Then write:

1. \`${rel(paths, paths.program)}\` — the program: \`export default defineProgram((endo) => ...)\`,
   importing from \`endograph\` only. Its first two lines are this header, verbatim (PROGRAM.md §2):

   \`\`\`
   // .endo/program/agent.ts — written by inception ${n} (${today()}). Do not edit:
   // change manifest.md or endograph.ts and run \`endo incept\`.
   \`\`\`

2. \`${rel(paths, paths.src)}/\` — seed it: procedures under \`procedures/\` for what the
   manifest makes obviously repeatable (PROGRAM.md §6.5, one file each,
   \`await procedure({...})\` first, imported from \`endograph/procedure\`),
   a \`README.md\` for the agent, notes the manifest implies (§7).

Rules to keep, all from PROGRAM.md: the contract (§2), reply exactly once
(§5.1), a compaction routine (§5.2), evidence versus instructions (§5.3),
the write rule (§5.4), the header (§5.5), purity (§5.6), no tool list in
prose (§5.7), no secrets (§5.8). Go through §8 before you finish.

Validation runs after you stop: the load pipeline (import, describe every
procedure, invoke, charter, hydrate, replay) and \`endo commands\`. A
procedure that fails to describe fails validation here. If validation
fails you get \`ERRORS.md\` in this workspace with the stage and the error,
and another round.

Do not edit \`endograph.ts\` or \`manifest.md\`. Do not run \`endo up\`.
`;
}

function rel(paths: Paths, path: string): string {
  return path.startsWith(paths.agentDir) ? path.slice(paths.agentDir.length + 1) : path;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** After a success: the owner's inputs, the program, and src as they stand. */
export function writeSnapshot(paths: Paths, grant: Grant, n: number): string {
  const dir = join(paths.snapshots, String(n));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(paths.grant, join(dir, "endograph.ts"));
  cpSync(resolve(paths.agentDir, grant.manifest), join(dir, "manifest.md"));
  cpSync(paths.program, join(dir, "agent.ts"));
  if (existsSync(paths.src)) cpSync(paths.src, join(dir, "src"), { recursive: true });
  return dir;
}
