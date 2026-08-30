import type { Frame } from "../store/types.ts";
import { endoPayloadOf } from "../world/world.ts";
import { localDate } from "./budget.ts";

/**
 * The daily digest: a deterministic, zero-token account of one day from the
 * frame log — what drifted, which rules fired, what the model judged, what
 * was escalated, what it cost. Batches the non-urgent into one read.
 */
export interface Digest {
  date: string;
  frames: number;
  drifts: number;
  incidents: number;
  ruleFirings: Record<string, number>;
  judgments: number;
  escalations: string[];
  spend: { opex: number; capex: number; activations: number };
  warnings: number;
}

export function computeDigest(frames: Frame[], date: string): Digest {
  const day = frames.filter((f) => localDate(f.at) === date);
  const digest: Digest = {
    date,
    frames: day.length,
    drifts: 0,
    incidents: new Set(day.map((f) => f.incident).filter(Boolean)).size,
    ruleFirings: {},
    judgments: 0,
    escalations: [],
    spend: { opex: 0, capex: 0, activations: 0 },
    warnings: 0,
  };
  for (const frame of day) {
    const payload = endoPayloadOf(frame);
    switch (frame.type) {
      case "drift":
        digest.drifts++;
        break;
      case "action": {
        const rule = typeof payload?.rule === "string" ? payload.rule : "(unknown)";
        digest.ruleFirings[rule] = (digest.ruleFirings[rule] ?? 0) + 1;
        break;
      }
      case "judgment":
        digest.judgments++;
        break;
      case "escalation":
        digest.escalations.push(frame.summary);
        break;
      case "spend": {
        const envelope = payload?.envelope === "capex" ? "capex" : "opex";
        digest.spend[envelope] += typeof payload?.usd === "number" ? payload.usd : 0;
        digest.spend.activations++;
        break;
      }
      case "budget":
        // Threshold warnings only — day-rollover and capex markers are also
        // "budget" frames but carry no threshold.
        if (typeof payload?.threshold === "number") digest.warnings++;
        break;
    }
  }
  return digest;
}

export function renderDigest(d: Digest): string {
  const lines = [
    `digest ${d.date}: ${d.frames} frames, ${d.drifts} drifts across ${d.incidents} incidents`,
  ];
  const rules = Object.entries(d.ruleFirings).sort((a, b) => b[1] - a[1]);
  lines.push(
    rules.length > 0
      ? `  rules fired: ${rules.map(([n, c]) => `${n}×${c}`).join(", ")}`
      : `  rules fired: none`,
  );
  lines.push(
    `  judgment: ${d.judgments} resolved, ${d.escalations.length} escalated` +
      (d.warnings > 0 ? `, ${d.warnings} budget warning(s)` : ""),
  );
  lines.push(
    `  spend: $${(d.spend.opex + d.spend.capex).toFixed(2)} over ${d.spend.activations} activation(s) ` +
      `(opex $${d.spend.opex.toFixed(2)}, capex $${d.spend.capex.toFixed(2)})`,
  );
  for (const e of d.escalations.slice(-5)) lines.push(`  ! ${e}`);
  return lines.join("\n");
}
