import { runMachine, type ExecutionReport, type Frame } from "@projectors/core";
import type { Outcome } from "../loop/types.ts";
import type { World } from "../world/world.ts";

/**
 * The judgment layer's driver: enqueue a report as a NON-inert actor frame
 * (the agent node's actor-frame trigger schedules the work) and let
 * projector's `runMachine` drain to quiescence. Every step frame the
 * machine synthesizes carries that step's execution report in its
 * provenance; summing them is the meter's input.
 */

/**
 * What woke the model. A drift is work the world or a peer put in front of
 * the agent; a session is self-initiated (the owner asked, or a battery
 * scheduled it). Batteries classify on the kind — a budget's envelopes are
 * exactly this split — and never on a label they did not define.
 */
export type ActivationTrigger =
  | { kind: "drift"; /** The drift's kind: "request.received". */ drift: string; incident: string }
  | { kind: "session"; /** The session's name: "learn", "capex". */ session: string; incident?: string };

export interface ActivationOutcome {
  trigger: ActivationTrigger;
  /** Terminal action's value, else the model's final text. */
  summary: string;
  /** Projector's completion reason: "terminal-action" | "done" | ... | "error". */
  completion: string;
  execution?: ExecutionReport;
}

export function describeTrigger(t: ActivationTrigger): string {
  return t.kind === "drift" ? `drift ${t.drift}` : `session ${t.session}`;
}

/** The activation as the loop sees it: handled unless it errored or escalated. */
export function asOutcome(outcome: ActivationOutcome): Outcome {
  const ok = outcome.completion !== "error" && outcome.completion !== "cancelled" && !outcome.summary.startsWith("escalate");
  return { ok, summary: outcome.summary };
}

export async function activate(world: World, opts: { text: string; trigger: ActivationTrigger }): Promise<ActivationOutcome> {
  const { machine } = world;
  // Fold whatever is queued first, so this run's frames are the only ones
  // whose execution reports we sum.
  await world.drain();
  machine.enqueueFrame({
    messages: [{ type: "user", text: opts.text, actor: { id: "endo:activation", label: "activation" } }],
    metadata: {
      endo: {
        type: "activation",
        summary: `activation (${describeTrigger(opts.trigger)})`,
        incident: opts.trigger.incident,
        at: Date.now(),
        payload: { trigger: opts.trigger },
      },
    },
  });

  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let latencyMs = 0;
  let model: string | undefined;
  let sawReport = false;
  let summary: string | undefined;
  let completion = "done";
  for await (const frame of runMachine(machine)) {
    const report = frame.provenance?.execution;
    if (report) {
      sawReport = true;
      usage.inputTokens += report.usage?.inputTokens ?? 0;
      usage.outputTokens += report.usage?.outputTokens ?? 0;
      usage.cachedInputTokens += report.usage?.cachedInputTokens ?? 0;
      latencyMs += report.latencyMs ?? 0;
      model ??= report.model;
    }
    for (const message of frame.messages) {
      if (message.type !== "work" || message.kind !== "completion" || message.reason === "absorbed" || message.reason === "suppressed") continue;
      completion = message.reason;
      // The completion points at the step's last result; endograph's convention is that it is the activation's result.
      const ref = message.lastResult;
      const pointed = ref && ref.frameId === frame.id ? frame.messages[ref.messageIndex] : undefined;
      if (pointed) summary = resultText(pointed) ?? summary;
    }
  }
  const outcome: ActivationOutcome = { trigger: opts.trigger, summary: summary ?? "(no summary)", completion };
  if (sawReport) outcome.execution = { latencyMs, ...(model ? { model } : {}), usage };
  return outcome;
}

/** A result-bearing message as text: an action result's value (or summary), or an assistant message's text. */
function resultText(message: Frame["messages"][number]): string | undefined {
  if (message.type === "action" && message.kind === "result") {
    const value = message.value;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string") return (value as { summary: string }).summary;
    return message.error ?? undefined;
  }
  const m = message as { text?: unknown; content?: unknown };
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    const text = m.content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
    return text || undefined;
  }
  return undefined;
}
