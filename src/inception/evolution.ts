import { allFrames, type Frame, type FrameStore } from "../store/types.ts";

/**
 * EVOLUTION.md: every reshaping of the instance since the last inception
 * (spawn, cede, transition, state update), grouped by the activation
 * that made it, with what triggered that activation and the reason the
 * agent gave. Context for the inceptor's migration of instance.json.
 */

type Msg = Record<string, unknown>;

export function renderEvolution(store: FrameStore, sinceSeq: number, n: number): string {
  const frames = [...allFrames(store, sinceSeq)];
  const byFrameId = new Map<string, Frame>();
  for (const f of frames) {
    const id = (f.payload as { id?: string } | undefined)?.id;
    if (id) byFrameId.set(id, f);
  }
  const groups = new Map<string, { source?: string; lines: string[] }>();
  for (const f of frames) {
    const payload = f.payload as { activationId?: string; messages?: Msg[] } | undefined;
    if (!payload?.messages) continue;
    const key = payload.activationId ?? `frame:${f.seq}`;
    const lines: string[] = [];
    let source: string | undefined;
    for (const m of payload.messages) {
      if (m.type === "work" && m.kind === "activation") {
        const src = byFrameId.get(m.sourceFrameId as string);
        source = src ? `${src.type} ${src.id ?? ""}: ${src.summary}`.trim() : undefined;
      }
      if (m.type === "action" && m.kind === "request" && ["spawn", "transition", "cede", "update_state"].includes(m.name as string)) {
        const input = (m.input ?? {}) as Msg;
        const node = input.node as Msg | undefined;
        const what =
          m.name === "update_state"
            ? `update_state ${input.state} (${input.op})`
            : m.name === "cede"
              ? `cede${input.key ? ` ${input.key}` : " (self)"}`
              : `${m.name} ${node?.key ?? "?"} (${node?.runtime ?? "component"}; tools: ${((node?.tools as string[] | undefined) ?? []).join(", ") || "none"})`;
        lines.push(`- ${what}${input.reason ? `: ${input.reason}` : ""}`);
      }
      if (m.type === "instance" && (m.kind === "spawn" || m.kind === "transition" || m.kind === "remove")) {
        const detail = m.kind === "spawn" ? `under ${m.parentInstanceId}` : m.kind === "transition" ? `of ${m.instanceId}` : `${m.instanceId} (${m.reason ?? "removed"})`;
        lines.push(`  · instance ${m.kind} ${detail} (frame ${f.seq})`);
      }
    }
    if (source === undefined && lines.length === 0) continue;
    const g = groups.get(key) ?? { lines: [] };
    if (source) g.source = source;
    g.lines.push(...lines);
    groups.set(key, g);
  }
  const sections = [...groups.values()].filter((g) => g.lines.length);
  const body = sections.length
    ? sections.map((g) => `## ${g.source ?? "an activation"}\n\n${g.lines.join("\n")}`).join("\n\n")
    : `(nothing: no spawn, cede, transition, or state update since inception ${n})`;
  return `# EVOLUTION: what the agent made of itself since inception ${n}\n\n${body}\n`;
}
