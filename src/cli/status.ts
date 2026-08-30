import type { AgentDir } from "../agent/dir.ts";
import { describeBudget } from "../economy/budget.ts";
import {
  allFrames,
  dim,
  dot,
  fmtTime,
  openAgentWorld,
  printFrame,
  supervisorMarker,
} from "./shared.ts";

export async function cmdStatus(dir: AgentDir): Promise<number> {
  const { store, world } = openAgentWorld(dir);
  const model = world.world();
  const frames = allFrames(store);

  const live = supervisorMarker(frames);
  console.log(
    live
      ? `agent "${dir.name}" — running ${dim(`(pid ${live.pid}, since ${fmtTime(live.at)})`)}`
      : `agent "${dir.name}" — ${dim("not running")}`,
  );

  const entries = Object.entries(model);
  if (entries.length === 0) {
    console.log(dim("  world model is empty"));
  }
  for (const [subject, entry] of entries) {
    console.log(`  ${dot(entry.state)} ${subject.padEnd(20)} ${entry.summary}`);
  }

  const budget = world.budget();
  if (budget.date) console.log(dim(`  budget: ${describeBudget(budget)}`));
  const lastCompaction = [...frames].reverse().find((f) => f.type === "compaction");
  console.log(
    dim(
      `  history: ${world.historyLength()} frames in view` +
        (lastCompaction ? ` (compacted ${fmtTime(lastCompaction.at)}; ${frames.length} in the log)` : ` (never compacted)`),
    ),
  );

  const answered = new Set(
    frames.filter((f) => f.type === "reply" && f.incident).map((f) => f.incident),
  );
  const open = frames.filter(
    (f) => f.type === "request" && f.incident && !answered.has(f.incident),
  );
  if (open.length > 0) {
    console.log(dim(`\n${open.length} request(s) awaiting reply:`));
    for (const frame of open.slice(-8)) printFrame(frame);
  }

  const recent = frames.slice(-8);
  if (recent.length > 0) {
    console.log(dim("\nrecent frames:"));
    for (const frame of recent) printFrame(frame);
  }
  const escalations = frames.filter(
    (f) => f.type === "escalation" && Date.now() - f.at < 24 * 3600 * 1000,
  );
  if (escalations.length > 0) {
    console.log(dim(`\n${escalations.length} unresolved escalation(s) in 24h — see \`endo why\``));
  }
  world.close();
  return 0;
}
