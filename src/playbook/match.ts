import type { Drift } from "../loop/types.ts";
import type { PlaybookEntry, Rule } from "./types.ts";

/** Glob with `*` wildcards only, anchored: "probe.*" matches "probe.failed". */
export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp("^" + glob.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First matching rule wins, in name order. Matching is pure: kind glob,
 * optional subject glob, optional regex over the drift text. Cooldowns are
 * the loop's business.
 */
export function matchRule(entries: PlaybookEntry[], drift: Drift): Rule | undefined {
  for (const entry of entries) {
    if (entry.kind !== "rule") continue;
    if (!globMatch(entry.on, drift.kind)) continue;
    if (entry.subject && !globMatch(entry.subject, drift.subject)) continue;
    if (entry.match && !entry.match.test(drift.detail ? `${drift.summary}\n${drift.detail}` : drift.summary)) continue;
    return entry;
  }
  return undefined;
}

/** Why a rule's matcher does not fire for a drift (for try_rule). */
export function explainMiss(rule: Rule, drift: Drift): string {
  if (!globMatch(rule.on, drift.kind)) return `on = "${rule.on}" does not match kind "${drift.kind}"`;
  if (rule.subject && !globMatch(rule.subject, drift.subject)) {
    return `subject = "${rule.subject}" does not match subject "${drift.subject}"`;
  }
  if (rule.match) return `match = /${rule.match.source}/ does not match "${drift.summary}"${drift.detail ? " or its detail" : ""}`;
  return "unknown reason";
}
