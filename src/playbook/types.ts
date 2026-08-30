/**
 * Playbook entries are files in the agent's own src/playbook/ — prose-first
 * markdown with TOML frontmatter (+++ fences), agent-authored over time,
 * hand-written in milestone 1. The minimal machine shape is matcher +
 * response + provenance; everything else is prose for the next reader
 * (human or model).
 *
 * Two entry kinds:
 *  - "rule":      pattern -> response. Drift matching a rule never wakes
 *                 the model. Matchers are plain regex, so poisoned logs can
 *                 at worst trigger an already-reviewed rule.
 *  - "procedure": an operation the agent knows how to perform — a script
 *                 (build, deploy, check) or bring-up (process defs).
 */

export interface PlaybookRule {
  kind: "rule";
  /** Filename stem; the rule's id in the frame log. */
  name: string;
  file: string;
  /** Drift kind glob, e.g. "process.exited" or "probe.*". */
  on: string;
  /** Optional subject glob, e.g. "process:metro". */
  subject?: string;
  /** Optional regex tested against `summary\ndetail` of the drift. */
  match?: RegExp;
  /** Where this rule came from (hand-written, distilled, incident #). */
  provenance: string;
  /**
   * Response: a shell script (first fenced code block in the body) and/or
   * a world-model verb. Verbs are the ergonomic safe path; scripts run
   * under the granted shell — writing a rule never escalates privilege.
   */
  script?: string;
  verb?: string;
  /** Suppress refiring for the same subject within this window. */
  cooldownSeconds: number;
  /**
   * What a failed response means. "judge" (default): the judgment layer
   * takes over with the rule's output in hand — scripts can be strict and
   * leave exceptions to the model. "settle": the failure is the outcome.
   */
  onFailure: "judge" | "settle";
  /** Prose body — the diagnosis story, for humans and future activations. */
  body: string;
}

/** Readiness is a real probe, not `sleep 5`. */
export type ReadyProbe =
  | { log: string /* regex against the process's own output */ }
  | { http: string /* URL that must answer 2xx-3xx */ }
  | { port: number /* TCP port that must accept */ };

export interface ProcessDef {
  name: string;
  cmd: string;
  /** Relative to the project directory. */
  cwd?: string;
  env?: Record<string, string>;
  /** Names of processes that must be ready first. */
  after?: string[];
  ready?: ReadyProbe;
  readyTimeoutSeconds: number;
}

/**
 * A named, repeatable operation the agent knows how to perform. Two
 * flavours share the shape: a script procedure (first fenced block in the
 * body; run with `run_procedure`, args as ENDO_ARG_* env) and the bring-up
 * procedure (process defs + readiness for the dev supervisor).
 */
export interface Procedure {
  kind: "procedure";
  name: string;
  file: string;
  provenance: string;
  processes: ProcessDef[];
  script?: string;
  body: string;
}

export type PlaybookEntry = PlaybookRule | Procedure;
