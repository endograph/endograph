/**
 * The loop's vocabulary. Domain-agnostic: nothing here may name a use case.
 */

/** A divergence between reality and the world model, emitted by a sensor. */
export interface Drift {
  /** Dot-namespaced class: "request.received", "call.received", ... */
  kind: string;
  /** World-model entry this concerns: "request:inc-1a2b". */
  subject: string;
  /** One line; what rule matchers run against. */
  summary: string;
  /**
   * Supporting evidence. UNTRUSTED: observed data, marked as such when it
   * enters model context; matchers treat it as opaque text.
   */
  detail?: string;
  data?: Record<string, unknown>;
  observedAt: number;
  /** Correlate with an existing incident instead of minting one. */
  incident?: string;
  /** Called exactly once with how the drift was handled. */
  settle?: (outcome: Outcome) => void;
}

/** Cheap deterministic watcher. Zero tokens. Poll-based. */
export interface Sensor {
  name: string;
  intervalMs: number;
  poll(): Promise<Drift[]>;
}

/** How a drift was handled: by a rule, by judgment, or why it was skipped. */
export interface Outcome {
  ok: boolean;
  summary: string;
  detail?: string;
  /** Not-ok by decision (exit 77): settle it, do not judge it. */
  refused?: boolean;
  /** Work continues in the background (exit 75): do not settle. */
  pending?: boolean;
}
