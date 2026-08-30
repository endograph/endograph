/**
 * Domain-agnostic core vocabulary. Nothing in this file may reference a
 * concrete use case (processes, k8s, queues, builds) — adapters and the
 * agent's charter own that.
 */

/** A divergence between reality and the world model, emitted by a sensor. */
export interface Drift {
  /** Dot-namespaced class, e.g. "process.exited", "request.received". */
  kind: string;
  /** World-model entry this concerns, e.g. "process:metro". */
  subject: string;
  /** One-line description; what playbook matchers run against. */
  summary: string;
  /**
   * Supporting evidence (log excerpt, diff). UNTRUSTED PROVENANCE: this is
   * observed data. It is marked as such when it ever enters model context,
   * and deterministic matchers treat it as opaque text.
   */
  detail?: string;
  data?: Record<string, unknown>;
  observedAt: number;
  /**
   * Correlate with an existing incident (a peer request already has one)
   * instead of minting a fresh id.
   */
  incident?: string;
  /**
   * Called exactly once with how the drift was handled — a rule's outcome,
   * the judgment layer's resolution, or why it was skipped. Sensors that
   * relay questions from peers use this to guarantee an answer.
   */
  settle?: (result: VerbResult) => void;
}

/** Cheap deterministic watcher. Zero tokens. Poll-based in v1. */
export interface Sensor {
  name: string;
  intervalMs: number;
  poll(): Promise<Drift[]>;
}

/**
 * A named capability the agent can exercise against its world model
 * (e.g. start/stop/restart/logs). Verbs are the always-shipped safe path:
 * easier than raw shell, attributed in the frame log.
 */
export interface Verb {
  name: string;
  description: string;
  /** subject is a world-model entry id; args are verb-specific. */
  run(subject: string, args?: Record<string, unknown>): Promise<VerbResult>;
}

export interface VerbResult {
  ok: boolean;
  summary: string;
  detail?: string;
  /** Not-ok by decision, not by failure: settle it, do not judge it. */
  refused?: boolean;
  /**
   * Work continues in the background; do not settle the drift. Whoever
   * finishes the work answers the request (`endo reply`).
   */
  pending?: boolean;
}

/**
 * The optional variable part of the anatomy: domain-specific sensors and
 * actuators for domains that need deterministic machinery (process
 * supervision). Charter-only agents run without one — the inbox, the
 * playbook, and the judgment layer are the whole anatomy.
 */
export interface Adapter {
  name: string;
  sensors(): Sensor[];
  verbs(): Verb[];
  /** Human-readable status lines for the status surface. */
  status(): Promise<StatusLine[]>;
  /** Bring the owned domain to its desired state. Resolves when converged. */
  up(): Promise<void>;
  /** Release everything the adapter holds (children, watchers). */
  shutdown(): Promise<void>;
}

export interface StatusLine {
  subject: string;
  state: "green" | "yellow" | "red" | "gray";
  summary: string;
}
