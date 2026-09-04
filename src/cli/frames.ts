import type { Frame } from "../store/types.ts";

/** One frame as a human reads it: the envelope line, then with `verbose` what the machine did in it. */
export function printFrame(f: Frame, verbose: boolean, say: (line: string) => void): void {
  say(`${String(f.seq).padStart(4)}  ${new Date(f.at).toISOString().slice(0, 19).replace("T", " ")}  ${f.type.padEnd(11)} ${f.id ?? ""}  ${f.summary}`);
  if (!verbose) return;
  const payload = f.payload as { messages?: Record<string, unknown>[]; text?: string; error?: string } | undefined;
  if (f.type === "reply" && typeof payload?.text === "string") say(indent(payload.text));
  if (f.type === "error" && typeof payload?.error === "string") say(indent(payload.error));
  for (const m of payload?.messages ?? []) {
    if (m.type === "user" && typeof m.text === "string") say(indent(`user: ${m.text}`));
    else if (m.type === "assistant" && typeof m.text === "string") say(indent(`assistant: ${m.text}`));
    else if (m.type === "action" && m.kind === "request") say(indent(`→ ${m.name} ${JSON.stringify(m.input)}`));
    else if (m.type === "action" && m.kind === "result") say(indent(`← ${m.name} ${m.success ? "ok" : "FAILED"}: ${String(m.value ?? m.error ?? "")}`));
    else if (m.type === "instance") say(indent(`instance ${m.kind}`));
    else if (m.type === "horizon") say(indent("horizon: history begins here"));
    else if (m.type === "work" && m.kind === "abort") say(indent(`abort: ${m.note ?? ""}`));
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n");
}

/** The frames about one request or call: its own, and every activation its frame sourced. */
export function framesAbout(frames: Frame[], id: string): Frame[] {
  const sourceFrames = new Set<string>();
  for (const f of frames) {
    const payload = f.payload as { id?: string; metadata?: { endo?: { ids?: string[] } } } | undefined;
    if ((f.id === id || payload?.metadata?.endo?.ids?.includes(id)) && payload?.id) sourceFrames.add(payload.id);
  }
  const activations = new Set<string>();
  for (const f of frames) {
    for (const m of ((f.payload as { messages?: Record<string, unknown>[] } | undefined)?.messages ?? [])) {
      if (m.type === "work" && m.kind === "activation" && sourceFrames.has(m.sourceFrameId as string)) activations.add(m.activationId as string);
    }
  }
  return frames.filter((f) => {
    const payload = f.payload as { activationId?: string; metadata?: { endo?: { ids?: string[] } }; messages?: Record<string, unknown>[] } | undefined;
    if (f.id === id || payload?.metadata?.endo?.ids?.includes(id)) return true;
    if (payload?.activationId && activations.has(payload.activationId)) return true;
    return (payload?.messages ?? []).some((m) => typeof m.activationId === "string" && activations.has(m.activationId));
  });
}
