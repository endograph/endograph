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
export function contextUpdate(projection: Projection, previous?: Cursor): string {
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
  return JSON.stringify(update);
}
