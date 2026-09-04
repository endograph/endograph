import type { Frame as ProjectorFrame, FrameMessage } from "@projectors/core";
import type { FrameInput } from "../store/types.ts";

/**
 * Every frame in the store carries the endograph envelope. A frame the
 * harness authors puts it in `metadata.endo`; a frame the machine produces
 * (an activation, a step, a completion) gets one derived from its content.
 */

export interface EndoMeta {
  type: string;
  summary: string;
  id?: string;
  /** Every request in a batch frame. */
  ids?: string[];
  at: number;
  /** Whatever else the author of the frame wants to keep (a request frame carries its delivered messages). */
  [key: string]: unknown;
}

export function endoMeta(meta: Omit<EndoMeta, "at"> & { at?: number }): { endo: EndoMeta } {
  return { endo: { ...meta, at: meta.at ?? Date.now() } as EndoMeta };
}

export function frameInputOf(frame: ProjectorFrame): FrameInput {
  const endo = (frame.metadata?.endo ?? {}) as Partial<EndoMeta>;
  return {
    type: endo.type ?? typeOf(frame.messages),
    summary: endo.summary ?? describe(frame.messages),
    id: endo.id,
    at: endo.at ?? Date.now(),
    payload: frame,
  };
}

function typeOf(messages: FrameMessage[]): string {
  if (messages.some((m) => m.type === "work" && m.kind === "activation")) return "activation";
  if (messages.some((m) => m.type === "work" && m.kind === "completion")) return "completion";
  if (messages.some((m) => m.type === "horizon")) return "compaction";
  if (messages.some((m) => m.type === "action")) return "action";
  if (messages.some((m) => m.type === "instance")) return "instance";
  return "frame";
}

function describe(messages: FrameMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.type === "work" && m.kind === "completion") parts.push(`completed: ${m.reason}`);
    else if (m.type === "work" && m.kind === "activation") parts.push(`activation of ${m.generatorId}`);
    else if (m.type === "action" && m.kind === "request") parts.push(`${m.name}(...)`);
    else if (m.type === "action" && m.kind === "result") parts.push(m.success ? `${m.name} ok` : `${m.name} failed: ${m.error ?? ""}`);
    else if (m.type === "instance") parts.push(`instance ${m.kind}`);
    else if (m.type === "assistant") parts.push(firstLine((m as { text?: string }).text ?? "(assistant)"));
    else if (m.type === "user") parts.push(firstLine((m as { text?: string }).text ?? "(user)"));
  }
  return parts.join("; ").slice(0, 200) || "frame";
}

export function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}
