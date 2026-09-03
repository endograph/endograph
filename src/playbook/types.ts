/**
 * Playbook entries are markdown files anywhere under the agent's src/ that
 * begin with a `+++` TOML frontmatter block. Files without frontmatter are
 * the agent's notes and are ignored. The script is the body's first fenced
 * code block; the prose is for the next reader, human or model.
 */

export interface Rule {
  kind: "rule";
  /** Filename stem; the rule's id in the frame log. */
  name: string;
  file: string;
  /** Drift kind glob: "request.received", "probe.*". */
  on: string;
  /** Optional subject glob: "request:*". */
  subject?: string;
  /** Optional regex over `summary\ndetail`. */
  match?: RegExp;
  provenance: string;
  cooldownSeconds: number;
  /** "judge": a failing script hands the drift to judgment with its output. "settle": the failure is the outcome. */
  onFailure: "judge" | "settle";
  script: string;
  body: string;
}

export interface ArgSpec {
  required: boolean;
  description?: string;
}

export interface Procedure {
  kind: "procedure";
  name: string;
  file: string;
  provenance: string;
  description?: string;
  /** Callable by peers as a `call` message (§7). */
  expose: boolean;
  /** Named args; arrive as ENDO_ARG_<NAME>. String-typed for now. */
  args: Record<string, ArgSpec>;
  script: string;
  body: string;
}

export type PlaybookEntry = Rule | Procedure;
