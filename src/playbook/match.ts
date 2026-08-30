import type { Drift } from "../core/types.ts";
import type { PlaybookEntry, PlaybookRule } from "./types.ts";

/** Glob with `*` wildcards only, anchored. "probe.*" matches "probe.failed". */
export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(
    "^" + glob.split("*").map(escapeRegExp).join(".*") + "$",
  );
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First matching rule wins, in filename order (deterministic). Matching is
 * pure: kind glob, optional subject glob, optional regex over the drift
 * text. Cooldown bookkeeping lives in the loop, not here.
 */
export function matchRule(
  entries: PlaybookEntry[],
  drift: Drift,
): PlaybookRule | undefined {
  for (const entry of entries) {
    if (entry.kind !== "rule") continue;
    if (!globMatch(entry.on, drift.kind)) continue;
    if (entry.subject && !globMatch(entry.subject, drift.subject)) continue;
    if (entry.match) {
      const text = drift.detail
        ? `${drift.summary}\n${drift.detail}`
        : drift.summary;
      if (!entry.match.test(text)) continue;
    }
    return entry;
  }
  return undefined;
}
