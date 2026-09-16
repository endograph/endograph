import { createHash } from "node:crypto";
import type { Projection } from "./protocol.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export interface Cursor { preamble: string; recency: string; tools: string; history: Record<string, number> }
export function cursor(projection: Projection, observed: string[] = []): Cursor {
  const history: Record<string, number> = {};
  for (const message of [...projection.history, ...observed]) { const key = digest(message); history[key] = (history[key] ?? 0) + 1; }
  return { preamble: projection.preamble, recency: projection.recency, tools: JSON.stringify(projection.tools), history };
}

/** Append snapshots and unseen occurrences; shrinking history never forces a session reset. */
export function contextUpdate(projection: Projection, previous?: Cursor, maxChars = Infinity): string {
  const update: Record<string, unknown> = {};
  if (projection.preamble !== previous?.preamble) update.preamble = JSON.parse(projection.preamble);
  if (projection.recency !== previous?.recency) update.recency = JSON.parse(projection.recency);
  if (JSON.stringify(projection.tools) !== previous?.tools) update.actions = projection.tools;
  const counts = { ...previous?.history };
  const history = projection.history.filter((message) => {
    const key = digest(message);
    if ((counts[key] ?? 0) > 0) { counts[key]!--; return false; }
    return true;
  });
  if (history.length) update.history = history.map((m) => JSON.parse(m));
  const full = JSON.stringify(update);
  if (full.length <= maxChars) return full;

  // Codex limits the combined text of turn/start, not each text item. Keep
  // standing instructions/state/catalog intact and a contiguous recent suffix.
  // This is a native prompt window only: Projector's durable log is unchanged.
  const entries = (update.history ?? []) as unknown[];
  const render = (omitted: number) => JSON.stringify({ ...update, history: entries.slice(omitted),
    historyWindow: { omittedMessages: omitted, notice: "Older history was omitted to fit Codex's input limit. It remains in Endograph's durable log. Current instructions, state and actions are complete. Retrieve older facts through available actions when needed; do not infer them from this window." } });
  if (!entries.length || render(entries.length - 1).length > maxChars)
    throw new Error("Codex context exceeds its input limit even without older history; reduce standing context or the newest history message.");
  let low = 1, high = entries.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (render(middle).length <= maxChars) high = middle;
    else low = middle + 1;
  }
  return render(low);
}
