import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSchema, type SerializedInstance } from "@projectors/core";
import type { Grant } from "../grant/grant.ts";
import { loadBatteries } from "../grant/bind.ts";
import { grantActions } from "../grant/core.ts";
import type { Paths } from "../harness/paths.ts";
import { readHostCatalogue } from "../host/provisions.ts";
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
  /** Plain descriptions only: no executor, host handler, or executable proxy. */
  description: GrantDescription;
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
    /** EVOLUTION.md: every reshaping since the last inception, with reasons. */
    evolution: string;
  };
}

export interface GrantDescription {
  executor: string;
  actions: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  states: { key: string; schema: Record<string, unknown> }[];
  batteries: { name: string; guide: string; fields: { name: string; description: string; schema: Record<string, unknown> }[] }[];
}

/** Describe trusted built-ins and cached host schemas without binding an
 * executor, importing an executor module, or constructing host proxies. */
export function describeGrant(paths: Paths, grant: Grant): GrantDescription {
  const batteries = loadBatteries(grant);
  const unavailable = (): never => { throw new Error("grant description cannot execute an action"); };
  const builtins = grantActions({ batteries, hostActions: [] },
    { name: grant.name, cwd: resolve(paths.agentDir, grant.cwd), charter: unavailable },
    { reply: unavailable });
  const actions: GrantDescription["actions"] = builtins.map((action) => ({
    name: action.name,
    description: action.description,
    ...(action.inputSchema ? { inputSchema: normalizeSchema(action.inputSchema).jsonSchema() } : {}),
  }));
  const catalogue = grant.hostActions.length ? readHostCatalogue(paths) : [];
  for (const name of grant.hostActions) {
    const descriptor = catalogue.find((action) => action.name === name);
    if (!descriptor) throw new Error(`no cached description for host action "${name}"; launch through the owner host first`);
    if (actions.some((action) => action.name === name)) throw new Error(`host action "${name}" conflicts with another granted action`);
    actions.push(descriptor);
  }
  return {
    executor: "module" in grant.executor ? `module ${grant.executor.module}` : "backend" in grant.executor ? `codex:${grant.executor.model ?? "default"}` : `${grant.executor.provider}:${grant.executor.model}`,
    actions,
    states: batteries.flatMap((battery) => (battery.states ?? []).map((state) => ({ key: state.key, schema: normalizeSchema(state.schema).jsonSchema() }))),
    batteries: batteries.map((battery) => ({
      name: battery.name, guide: battery.guide,
      fields: Object.entries(battery.procedure?.fields ?? {}).map(([name, field]) => ({ name, description: field.description, schema: normalizeSchema(field.schema).jsonSchema() })),
    })),
  };
}

export function renderWorkspace(input: WorkspaceInput): string {
  const { paths, grant } = input;
  const dir = paths.workspace;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "batteries"), { recursive: true });
  writeFileSync(join(dir, "MANIFEST.md"), grant.manifest.text);
  writeFileSync(join(dir, "GRANT.md"), renderGrant(input));
  writeFileSync(join(dir, "PROGRAM.md"), readFileSync(PROGRAM_DOC, "utf8"));
  writeFileSync(join(dir, "CLI.md"), CONSUMER_DOC);
  for (const b of input.description.batteries) writeFileSync(join(dir, "batteries", `${b.name}.md`), b.guide);
  if (input.baseline) {
    const { baseline } = input;
    mkdirSync(join(dir, "BASELINE"), { recursive: true });
    cpSync(join(baseline.dir, "agent.ts"), join(dir, "BASELINE", "agent.ts"));
    if (existsSync(join(baseline.dir, "src"))) cpSync(join(baseline.dir, "src"), join(dir, "BASELINE", "src"), { recursive: true });
    writeFileSync(join(dir, "DIFF.md"), `# DIFF: owner inputs at inception ${input.n - 1} versus now\n\n${baseline.diff.trim() ? "```diff\n" + baseline.diff.trimEnd() + "\n```" : "(no change to manifest.md, endograph.toml, or the endograph version)"}\n`);
    if (baseline.errors) writeFileSync(join(dir, "ERRORS.md"), `# ERRORS: the current program does not load\n\n${baseline.errors}\n`);
    if (baseline.instance !== undefined) writeFileSync(join(dir, "instance.json"), `${JSON.stringify(baseline.instance, null, 2)}\n`);
    writeFileSync(join(dir, "EVOLUTION.md"), baseline.evolution);
  }
  writeFileSync(join(dir, "TASK.md"), renderTask(input));
  return dir;
}

export function renderGrant({ grant, description, version }: WorkspaceInput): string {
  const lines: string[] = [
    `# GRANT: ${grant.name}`,
    "",
    "The supported capabilities selected by `endograph.toml`. The process sandbox controls resource access.",
    "",
    `- name: \`${grant.name}\``,
    `- executor: ${description.executor}`,
    `- executor config: \`${JSON.stringify(grant.executor)}\``,
    `- cwd (where procedures and bash run): \`${grant.cwd}\` relative to the agent directory`,
    `- batteries: ${grant.batteries.length ? grant.batteries.map((name) => `\`${name}\``).join(", ") : "(none)"}`,
    `- endograph ${version}`,
    "",
    "## Actions (`endo.actions.<name>`)",
    "",
  ];
  for (const a of description.actions) {
    lines.push(`### ${a.name}`, "", a.description ?? "(no description)", "");
    if (a.inputSchema) lines.push("```json", JSON.stringify(a.inputSchema, null, 2), "```", "");
  }
  lines.push("## States (`endo.states.<key>`)", "");
  if (description.states.length === 0) lines.push("(none granted; declare your own with `createState` on the nodes that use them)", "");
  for (const s of description.states) {
    lines.push(`### ${s.key}`, "", "```json", JSON.stringify(s.schema, null, 2), "```", "");
  }
  lines.push(
    "## Procedure options",
    "",
    "`procedure({ description, expose?, args?, ...fields })`: `description` (string, required), `expose` (boolean; peers may `endo call` it), `args` (an object of Standard Schemas, one per arg; `z` from `endograph`).",
    "",
  );
  for (const b of description.batteries) {
    for (const field of b.fields) {
      lines.push(`- \`${field.name}\` (${b.name}): ${field.description}`, "  ```json", `  ${JSON.stringify(field.schema)}`, "  ```");
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
\`instance.json\` (the persisted instance: what the agent has made of
itself; migrate it to the new program, PROGRAM.md §9)` : ""}, and
\`EVOLUTION.md\` (every spawn, cede, transition, and state update since
inception ${n - 1}, with what triggered it and the reason the agent gave:
the context for that migration). The current program and src are in
place under \`.endo/\`; the agent's own procedures and notes are
preserved unless the new intent forbids them.

Before you finish, write \`CHANGES.md\` in this workspace: a short brief
to the agent, in the second person, saying what changed in its program,
what of its own work was absorbed or moved, and what it should do
differently. The agent reads it as its first request after this
inception.
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
   // change manifest.md or endograph.toml and run \`endo incept\`.
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

Do not edit \`endograph.toml\` or the manifest. Do not run \`endo up\`.
`;
}

function rel(paths: Paths, path: string): string {
  return path.startsWith(paths.agentDir) ? path.slice(paths.agentDir.length + 1) : path;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A candidate generation's inputs, code and migrated instance. Promotion
 * commits its matching frame/checkpoint together before this becomes current. */
export function writeSnapshot(paths: Paths, grant: Grant, n: number, instance: SerializedInstance): string {
  const dir = join(paths.snapshots, String(n));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(paths.grant, join(dir, "endograph.toml"));
  writeFileSync(join(dir, "manifest.md"), grant.manifest.text);
  cpSync(paths.program, join(dir, "agent.ts"));
  writeFileSync(join(dir, "instance.json"), `${JSON.stringify(instance, null, 2)}\n`);
  if (existsSync(paths.src)) cpSync(paths.src, join(dir, "src"), { recursive: true });
  return dir;
}
