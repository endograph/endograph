import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionResult, createAction, normalizeSchema, schemaFromJsonSchema, type AnyAction } from "@projectors/core";
import type { Battery } from "../grant/grant.ts";
import type { ProcedureMeta } from "./lib.ts";
import type { RunStarter } from "./runs.ts";

/**
 * Describe mode: import every script directly under `src/procedures/` with
 * ENDO_DESCRIBE set, so `procedure()` throws its metadata instead of doing
 * work. A script that fails to describe is left out and reported; it never
 * fails the load.
 */

export interface ProcedureSpec extends ProcedureMeta {
  name: string;
  file: string;
  /** The tool and command schema: one object with a property per arg. */
  inputSchema: Record<string, unknown>;
}

export interface DescribeFailure {
  name: string;
  file: string;
  error: string;
}

const NAME = /^[a-z][a-z0-9_-]*$/;

export async function describeProcedures(dir: string, batteries: Battery[] = []): Promise<{ procedures: ProcedureSpec[]; failures: DescribeFailure[] }> {
  const procedures: ProcedureSpec[] = [];
  const failures: DescribeFailure[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
  } catch {
    return { procedures, failures };
  }
  const files: string[] = [];
  for (const f of names) {
    const name = basename(f, ".ts");
    if (NAME.test(name)) files.push(join(dir, f));
    else failures.push({ name, file: join(dir, f), error: `procedure file names are [a-z][a-z0-9_-]*: ${f}` });
  }
  if (files.length === 0) return { procedures, failures };
  const results = await describeInProcess(files, resolve(dir, "../../tmp"));
  for (const file of files) {
    const name = basename(file, ".ts");
    const r = results.get(file);
    if (!r) failures.push({ name, file, error: `did not finish describing within ${DESCRIBE_TIMEOUT_MS / 1000}s: nothing may block before procedure()` });
    else if (r.error !== undefined || !r.meta) failures.push({ name, file, error: r.error ?? "no metadata" });
    else {
      const problem = checkFields(name, r.meta.fields, batteries);
      if (problem) failures.push({ name, file, error: problem });
      else procedures.push({ name, file, ...r.meta, inputSchema: inputSchemaOf(r.meta) });
    }
  }
  return { procedures, failures };
}

/** Every field a script gave must belong to a granted battery and satisfy its schema and validator. */
function checkFields(name: string, values: Record<string, unknown>, batteries: Battery[]): string | null {
  const problems: string[] = [];
  for (const [field, value] of Object.entries(values)) {
    const owner = batteries.find((b) => b.procedure && field in b.procedure.fields);
    if (!owner) {
      problems.push(`unknown procedure() field "${field}" (granted: ${batteries.flatMap((b) => Object.keys(b.procedure?.fields ?? {})).join(", ") || "none"})`);
      continue;
    }
    const check = normalizeSchema(owner.procedure!.fields[field]!.schema).check(value);
    if (check.issues?.length) problems.push(`${field}: ${check.issues.map((i) => i.message).join("; ")}`);
  }
  for (const b of batteries) {
    if (!b.procedure?.validate) continue;
    const own = Object.fromEntries(Object.entries(values).filter(([k]) => k in b.procedure!.fields));
    const problem = b.procedure.validate(own, name);
    if (problem) problems.push(problem);
  }
  return problems.length ? problems.join("; ") : null;
}

const DESCRIBER = fileURLToPath(new URL("./describer.ts", import.meta.url));
const DESCRIBE_TIMEOUT_MS = 30_000;

/** One child process imports every file fresh; the harness process never runs a procedure's top-level code. */
async function describeInProcess(files: string[], temp: string): Promise<Map<string, { meta?: ProcedureMeta; error?: string }>> {
  mkdirSync(temp, { recursive: true });
  const out = join(temp, `endo-describe-${crypto.randomUUID()}.jsonl`);
  const child = spawn(process.execPath, ["run", DESCRIBER, out, ...files], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), DESCRIBE_TIMEOUT_MS);
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  clearTimeout(timer);
  const results = new Map<string, { meta?: ProcedureMeta; error?: string }>();
  try {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { file: string; meta?: ProcedureMeta; error?: string };
      results.set(r.file, r);
    }
  } catch {}
  rmSync(out, { force: true });
  if (results.size === 0 && stderr.trim()) {
    for (const file of files) results.set(file, { error: `describe failed: ${stderr.trim().split("\n")[0]}` });
  }
  return results;
}

function inputSchemaOf(meta: ProcedureMeta): Record<string, unknown> {
  const required = Object.entries(meta.args)
    .filter(([, schema]) => !accepts(schema, undefined))
    .map(([key]) => key);
  return { type: "object", properties: meta.args, required, additionalProperties: false };
}

/** Whether a JSON Schema admits `undefined` (an optional arg). */
function accepts(schema: Record<string, unknown>, value: unknown): boolean {
  try {
    return normalizeSchema(schemaFromJsonSchema(schema)).accepts(value);
  } catch {
    return false;
  }
}

/** A procedure as the model's tool: calling it starts a run; the run's first reply is the result. */
export function compileProcedure(spec: ProcedureSpec, start: RunStarter): AnyAction {
  return createAction({
    state: null,
    name: spec.name,
    description: spec.description,
    inputSchema: schemaFromJsonSchema<Record<string, unknown>>(spec.inputSchema),
    run: async (input) => {
      const run = start({ procedure: spec, args: input });
      const first = await run.first;
      return first.ok ? first.text : actionResult({ success: false, error: first.text });
    },
  });
}
