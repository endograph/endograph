import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../harness/paths.ts";

/**
 * `.endo/inceptions/<n>/`: the evidence of an inception, kept whether or
 * not it succeeded. The workspace as the inceptor read it, and per round
 * what the inceptor said, what it wrote, and what validation made of it.
 * The snapshot is the baseline the next inception starts from; this is
 * the record of how the last one went. Cleared when inception n is
 * attempted again.
 */

export interface RecordMeta {
  n: number;
  version: string;
  /** The inceptor command, or "manual". */
  inceptor: string;
  prompt?: string;
}

export interface RoundInput {
  /** The inceptor's output; absent for a manual round. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  inceptorMs?: number;
  validateMs: number;
  /** Validation's error text, or null when it passed. */
  errors: string | null;
}

export interface InceptionRecord {
  dir: string;
  round(k: number, input: RoundInput): void;
  close(outcome: "recorded" | "failed", rounds: number, error?: string): void;
}

export function openRecord(paths: Paths, meta: RecordMeta, opts: { keep?: boolean } = {}): InceptionRecord {
  const dir = join(paths.inceptions, String(meta.n));
  const file = join(dir, "inception.json");
  if (!opts.keep || !existsSync(file)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (existsSync(paths.workspace)) cpSync(paths.workspace, join(dir, "workspace"), { recursive: true });
    writeJson(file, { ...meta, started: new Date().toISOString() });
  }
  return {
    dir,
    round(k, input) {
      const round = join(dir, "rounds", String(k));
      rmSync(round, { recursive: true, force: true });
      mkdirSync(round, { recursive: true });
      const { stdout, stderr, errors, ...rest } = input;
      if (stdout !== undefined) writeFileSync(join(round, "stdout.txt"), stdout);
      if (stderr) writeFileSync(join(round, "stderr.txt"), stderr);
      if (errors) writeFileSync(join(round, "ERRORS.md"), `# ERRORS (round ${k})\n\n${errors}\n`);
      if (existsSync(paths.program)) cpSync(paths.program, join(round, "agent.ts"));
      if (existsSync(paths.src)) cpSync(paths.src, join(round, "src"), { recursive: true });
      for (const f of ["CHANGES.md", "instance.json"]) if (existsSync(join(paths.workspace, f))) cpSync(join(paths.workspace, f), join(round, f));
      writeJson(join(round, "round.json"), { round: k, at: new Date().toISOString(), ...rest, passed: !errors, ...(errors ? { stage: stageOf(errors) } : {}) });
    },
    close(outcome, rounds, error) {
      const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeJson(file, { ...meta, finished: new Date().toISOString(), rounds, outcome, ...(error ? { error } : {}) });
    },
  };
}

/** Validation errors read "<stage>: <detail>"; the stage is what the harness can be iterated on. */
function stageOf(errors: string): string {
  return errors.split("\n")[0]?.split(":")[0]?.trim() || "unknown";
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
