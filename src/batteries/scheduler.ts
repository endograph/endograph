import { z } from "zod";
import type { Battery } from "../grant/define.ts";

/**
 * The scheduler battery: a `schedule` procedure field (five-field cron)
 * and a tick that starts each due procedure as `timer:<name>`. A
 * scheduled procedure that emits a message is a standing self-initiated
 * activation; nothing else is needed for one. Scheduling is opinionated
 * and differs between apps, which is why it is a battery.
 */

export function scheduler(): Battery {
  const fired = new Map<string, number>();
  return {
    name: "scheduler",
    guide: GUIDE,
    procedure: {
      fields: { schedule: { schema: z.string(), description: "when to run it, as five-field cron (minute hour day-of-month month day-of-week) in local time" } },
      validate: (values) => (typeof values.schedule === "string" && !parseCron(values.schedule) ? `schedule: not a five-field cron expression: ${values.schedule}` : null),
    },
    hooks: {
      tick(now, ctx) {
        const minute = Math.floor(now / 60_000);
        for (const p of ctx.procedures) {
          const expr = typeof p.fields.schedule === "string" ? parseCron(p.fields.schedule) : null;
          if (!expr || fired.get(p.name) === minute || !matches(expr, new Date(minute * 60_000))) continue;
          fired.set(p.name, minute);
          ctx.call(p.name, {});
        }
      },
    },
  };
}

type Cron = Set<number>[];

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 7 is Sunday too
];

/** Five fields; each `*`, `n`, `a-b`, a `/step` suffix on either, or a comma list of those. Null when malformed. */
export function parseCron(text: string): Cron | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed: Cron = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = RANGES[i]!;
    const set = new Set<number>();
    for (const part of fields[i]!.split(",")) {
      const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
      if (!m) return null;
      const step = m[4] ? Number(m[4]) : 1;
      const from = m[1] === "*" ? lo : Number(m[2]);
      const to = m[1] === "*" ? hi : m[3] ? Number(m[3]) : m[4] ? hi : from;
      if (step < 1 || from < lo || to > hi || from > to) return null;
      for (let v = from; v <= to; v += step) set.add(v === 7 && i === 4 ? 0 : v);
    }
    parsed.push(set);
  }
  return parsed;
}

export function matches(cron: Cron, at: Date): boolean {
  return cron[0]!.has(at.getMinutes()) && cron[1]!.has(at.getHours()) && cron[2]!.has(at.getDate()) && cron[3]!.has(at.getMonth() + 1) && cron[4]!.has(at.getDay());
}

const GUIDE = `# scheduler

One procedure field, \`schedule\`: five-field cron in local time (minute
hour day-of-month month day-of-week; \`*\`, \`n\`, \`a-b\`, a \`/step\`
suffix, lists). While the agent runs, a due procedure is started as
\`timer:<name>\` with no args; its call and replies are frames like any
other. Nothing runs while the agent is down, and a missed minute is not
made up.

Idioms:

- A standing self-initiated activation is a scheduled procedure that
  calls \`actionResult()\` and then \`emitMessage()\` to its own agent: a
  nightly digest, a self-review, a retry loop for a host that was asleep.
  The message's text is the brief; the agent answers it like any request.
- A scheduled procedure that does its work without the model (a health
  check that only emits when something is wrong) costs nothing while all
  is well.
- Keep schedules coarse. Every emitted message is an activation.
`;
