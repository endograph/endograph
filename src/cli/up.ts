import { ensureAgentSkeleton, type AgentDir } from "../agent/dir.ts";
import { loadConfig, type AgentConfig } from "../agent/config.ts";
import { DevAdapter } from "../adapters/dev/adapter.ts";
import { Loop } from "../core/loop.ts";
import type { Adapter, VerbResult } from "../core/types.ts";
import { describeBudget, freshBudget, localDate, reseedBudget } from "../economy/budget.ts";
import { computeDigest, renderDigest } from "../economy/digest.ts";
import { recordSpend } from "../economy/meter.ts";
import { Inbox } from "../inbox/inbox.ts";
import { activate, capexReport, driftReport, composeInstructions, LEARN_REPORT } from "../judge/activate.ts";
import { statSync } from "node:fs";
import { loadPlaybook } from "../playbook/parse.ts";
import type { PlaybookEntry } from "../playbook/types.ts";
import type { FrameStore } from "../store/types.ts";
import type { World } from "../world/world.ts";
import { allFrames, dot, fmtTime, dim } from "./shared.ts";
import { buildExecutor, openJudgedWorld, readCharter } from "./wire.ts";

const ECONOMY_TICK_MS = 60_000;

/**
 * `endo up` — run the agent. Always: the inbox (peers' requests) and the
 * judgment layer under the charter. When the playbook has a bring-up
 * procedure with processes, also the dev supervisor adapter.
 */
export async function cmdUp(dir: AgentDir): Promise<number> {
  ensureAgentSkeleton(dir);
  let config = await loadConfig(dir.configPath);

  let playbook: PlaybookEntry[] = await loadPlaybook(dir.playbookDir);
  const bringUp = playbook.find(
    (e) => e.kind === "procedure" && e.name === "bring-up",
  );
  const supervises =
    bringUp?.kind === "procedure" && bringUp.processes.length > 0;

  const reloadPlaybook = async () => {
    playbook = await loadPlaybook(dir.playbookDir);
  };
  const { world, store, runtime } = await openJudgedWorld(dir, config, reloadPlaybook, {
    supervises,
    // Frames stream to the terminal as they are recorded — the live surface.
    onFrame: (input) =>
      console.log(`${dim(fmtTime(input.at))} ${input.type.padEnd(10)} ${input.summary}`),
  });
  const liveWorld: World = world;
  const record: typeof world.record = (input, entries) => world.record(input, entries);
  const recordNow: Parameters<typeof runtime.bind>[0]["record"] = (input, entries) =>
    record({ at: Date.now(), ...input }, entries);

  const adapter: Adapter | undefined = supervises
    ? new DevAdapter({
        defs: bringUp!.kind === "procedure" ? bringUp!.processes : [],
        projectDir: dir.project,
        record: recordNow,
      })
    : undefined;
  const inbox = new Inbox({ dir: dir.inboxDir, record: recordNow });
  const verbs = new Map((adapter?.verbs() ?? []).map((v) => [v.name, v]));

  runtime.bind({
    verbs,
    projectDir: dir.project,
    agentDir: dir.root,
    playbookDir: dir.playbookDir,
    playbook: () => playbook,
    onPlaybookChanged: reloadPlaybook,
    record: recordNow,
    inbox,
  });

  const session = async (opts: {
    text: string;
    reason: string;
    incident?: string;
    subject?: string;
  }): Promise<VerbResult> => {
    const outcome = await activate(liveWorld, opts);
    recordSpend(liveWorld, config, {
      reason: opts.reason,
      execution: outcome.execution,
      incident: opts.incident,
    });
    record({
      type: outcome.reason === "error" ? "escalation" : "judgment",
      subject: opts.subject,
      summary: outcome.summary,
      incident: opts.incident,
      at: Date.now(),
    });
    const summary = runtime.takeCompactionRequest();
    if (summary) liveWorld.compact(summary);
    return {
      ok: outcome.reason !== "error" && !outcome.summary.startsWith("escalate:"),
      summary: outcome.summary,
    };
  };

  const capex = (ask?: string, incident?: string, subject?: string) =>
    session({
      text: capexReport(ask, liveWorld.historyLength()),
      reason: "capex:session",
      incident,
      subject,
    });

  // Lazy capex: every N opex activations, a research session — paced by
  // the workload. Runs right after the Nth, while the loop is already busy.
  const judge = async (opts: {
    text: string;
    reason: string;
    incident?: string;
    subject?: string;
  }): Promise<VerbResult> => {
    const result = await session(opts);
    const every = config.schedule.capex_every;
    const budget = liveWorld.budget();
    const count = (budget.opexSinceCapex ?? 0) + 1;
    const due = every > 0 && count >= every;
    liveWorld.recordBudget(
      {
        type: "budget",
        summary: due
          ? `capex due: ${count} opex activations since the last session`
          : `opex activations since capex: ${count}${every > 0 ? `/${every}` : ""}`,
        at: Date.now(),
      },
      { ...budget, opexSinceCapex: due ? 0 : count },
    );
    if (due) {
      console.log(dim(`${fmtTime(Date.now())} activation  capex session (every ${every} opex)…`));
      await capex().catch((err) =>
        record({
          type: "escalation",
          summary: `capex session failed: ${err instanceof Error ? err.message : err}`,
          at: Date.now(),
        }),
      );
    }
    return result;
  };

  const loop = new Loop({
    world: liveWorld,
    sensors: [...(adapter?.sensors() ?? []), inbox.sensor()],
    verbs,
    playbook: () => playbook,
    projectDir: dir.project,
    agentDir: dir.root,
    onUnmatched: async (drift, incident, context) => {
      const ruleNames = playbook
        .filter((e) => e.kind === "rule")
        .map((e) => e.name);
      // An owner-requested research session rides the inbox like any
      // request; it runs the capex prompt against the capex envelope.
      const requests = (drift.data?.requests ?? []) as { session?: string; text: string }[];
      if (requests.length > 0 && requests.every((r) => r.session === "capex")) {
        console.log(dim(`${fmtTime(Date.now())} activation  capex session (on request)…`));
        return capex(requests.map((r) => r.text).join("\n"), incident, drift.subject);
      }
      if (requests.length > 0 && requests.every((r) => r.session === "learn")) {
        console.log(dim(`${fmtTime(Date.now())} activation  learning session (on request)…`));
        return session({ text: LEARN_REPORT, reason: "capex:learn", incident, subject: drift.subject });
      }
      console.log(dim(`${fmtTime(Date.now())} activation  judging [${drift.kind}] ${drift.subject}…`));
      return judge({
        text: driftReport(drift, ruleNames, context?.ruleFailure),
        reason: "opex:drift",
        incident,
        subject: drift.subject,
      });
    },
  });

  const procedures = playbook.filter((e) => e.kind === "procedure" && e.script).length;
  record({
    type: "note",
    summary:
      `endo up: agent "${dir.name}", ` +
      (adapter ? `${bringUp!.kind === "procedure" ? bringUp!.processes.length : 0} processes, ` : "") +
      `${procedures} procedures, ${playbook.filter((e) => e.kind === "rule").length} rules, ` +
      `model ${config.model.model}`,
    payload: { supervisor: "start", pid: process.pid },
    at: Date.now(),
  });

  // The economy: day rollover (digest + fresh budget). Soft throughout —
  // meter, project, warn; never enforce.
  const rollover = () => rolloverBudget(liveWorld, store, config);

  // Rules and procedures written by another process (a `endo capex`
  // session, the owner's editor) apply live: poll the playbook dir. The
  // mandate (charter.md) and the grant (endograph.toml) reload the same way —
  // the machine is rebuilt under the new charter, nothing is lost.
  let playbookStamp = playbookStampOf(dir.playbookDir);
  let mandateStamp = mandateStampOf(dir);
  const reloadMandate = async () => {
    const next = await loadConfig(dir.configPath);
    const modelChanged =
      next.model.provider !== config.model.provider || next.model.model !== config.model.model;
    config = next;
    liveWorld.reconfigure({
      instructions: composeInstructions(await readCharter(dir)),
      ...(modelChanged ? { executor: buildExecutor(config) } : {}),
    });
    const reseeded = reseedBudget(config, liveWorld.budget());
    if (reseeded) {
      liveWorld.recordBudget(
        { type: "budget", summary: `grant changed: ${describeBudget(reseeded)}`, at: Date.now() },
        reseeded,
      );
    }
    record({
      type: "note",
      summary: `charter/grant reloaded (model ${config.model.model}, capex every ${config.schedule.capex_every})`,
      at: Date.now(),
    });
  };
  const playbookTimer = setInterval(async () => {
    const mandate = mandateStampOf(dir);
    if (mandate !== mandateStamp) {
      mandateStamp = mandate;
      try {
        await reloadMandate();
      } catch (err) {
        record({
          type: "error",
          subject: "charter",
          summary: `charter/grant reload failed (still on the previous ones): ${err instanceof Error ? err.message : err}`,
          at: Date.now(),
        });
      }
    }
    const stamp = playbookStampOf(dir.playbookDir);
    if (stamp === playbookStamp) return;
    playbookStamp = stamp;
    try {
      await reloadPlaybook();
      record({
        type: "note",
        summary: `playbook reloaded: ${playbook.filter((e) => e.kind === "rule").length} rules, ${
          playbook.filter((e) => e.kind === "procedure").length
        } procedures`,
        at: Date.now(),
      });
    } catch (err) {
      record({
        type: "error",
        subject: "playbook",
        summary: `playbook reload failed: ${err instanceof Error ? err.message : err}`,
        at: Date.now(),
      });
    }
  }, 3000);

  rollover();
  {
    // The grant may have changed since the budget state was seeded.
    const reseeded = reseedBudget(config, liveWorld.budget());
    if (reseeded) {
      liveWorld.recordBudget(
        { type: "budget", summary: `grant changed: ${describeBudget(reseeded)}`, at: Date.now() },
        reseeded,
      );
    }
  }
  const economyTimer = setInterval(rollover, ECONOMY_TICK_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(economyTimer);
    clearInterval(playbookTimer);
    record({
      type: "note",
      summary: `endo up: ${signal}, shutting down`,
      payload: { supervisor: "stop", pid: process.pid },
      at: Date.now(),
    });
    await loop.stop();
    await adapter?.shutdown();
    world.snapshot();
    world.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await adapter?.up();
  loop.start();

  if (adapter) {
    for (const line of await adapter.status()) {
      console.log(`  ${dot(line.state)} ${line.subject.padEnd(20)} ${line.summary}`);
    }
  } else {
    for (const [subject, entry] of Object.entries(liveWorld.world())) {
      console.log(`  ${dot(entry.state)} ${subject.padEnd(20)} ${entry.summary}`);
    }
  }
  console.log(dim(`  budget: ${describeBudget(liveWorld.budget())}`));
  console.log(dim(`  inbox: ${dir.inboxDir}`));
  console.log(dim("running — ctrl-c to stop"));

  // Runs until a signal arrives.
  await new Promise(() => {});
  return 0;
}

function mandateStampOf(dir: AgentDir): string {
  const stamp = (path: string) => {
    try {
      return String(statSync(path).mtimeMs);
    } catch {
      return "-";
    }
  };
  return `${stamp(dir.charterPath)}|${stamp(dir.configPath)}`;
}

function playbookStampOf(playbookDir: string): string {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(playbookDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => `${f}:${statSync(`${playbookDir}/${f}`).mtimeMs}`)
      .join("|");
  } catch {
    return "";
  }
}

/** On a new day: digest the previous one, seed today's budget from the grant. */
export function rolloverBudget(world: World, store: FrameStore, config: AgentConfig): void {
  const today = localDate();
  const budget = world.budget();
  if (budget.date === today) return;
  if (budget.date) {
    const digest = computeDigest(allFrames(store), budget.date);
    world.record({
      type: "digest",
      summary: renderDigest(digest).split("\n")[0]!,
      payload: digest as unknown as Record<string, unknown>,
      at: Date.now(),
    });
    console.log(renderDigest(digest));
  }
  const next = freshBudget(config, today, budget);
  world.recordBudget(
    {
      type: "budget",
      summary:
        `budget day ${today}: ` +
        (next.dailyUsd != null
          ? `$${next.dailyUsd.toFixed(2)} allowance (opex ${Math.round(next.envelopes.opex * 100)}% / capex ${Math.round(next.envelopes.capex * 100)}%)`
          : "no daily allowance set — metering only"),
      at: Date.now(),
    },
    next,
  );
}
