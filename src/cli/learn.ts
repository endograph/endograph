import { ensureAgentSkeleton, type AgentDir } from "../agent/dir.ts";
import { loadConfig } from "../agent/config.ts";
import { describeBudget } from "../economy/budget.ts";
import { recordSpend } from "../economy/meter.ts";
import { activate, capexReport, LEARN_REPORT } from "../judge/activate.ts";
import { loadPlaybook } from "../playbook/parse.ts";
import type { World } from "../world/world.ts";
import { existsSync } from "node:fs";
import { newIncident, waitForReply, writeRequest } from "../inbox/inbox.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { dim, supervisorAlive } from "./shared.ts";
import { rolloverBudget } from "./up.ts";
import { openJudgedWorld } from "./wire.ts";

/**
 * `endo learn` — a learning session: the agent reads its charter, explores
 * the project, and compiles what it needs (procedures, bring-up, rules)
 * into its own playbook. Capex: the flagship asset. Re-runnable; entries
 * are overwritten by name.
 */
export async function cmdLearn(dir: AgentDir): Promise<number> {
  if (existsSync(dir.dbPath) && supervisorAlive(openSqliteStore(dir.dbPath), true)) {
    // The running agent learns in-process (its machine sees the frames);
    // this just asks and waits.
    const request = {
      incident: newIncident(),
      from: process.cwd(),
      text: "learning session",
      at: Date.now(),
      session: "learn",
    };
    writeRequest(dir.inboxDir, request);
    console.log(dim(`${request.incident} — learning session requested; waiting…`));
    const store = openSqliteStore(dir.dbPath);
    try {
      const reply = await waitForReply(store, request.incident, { timeoutMs: 30 * 60 * 1000 });
      if (!reply) {
        console.error("no reply within 30 minutes");
        return 2;
      }
      console.log(reply.text);
      return reply.ok ? 0 : 1;
    } finally {
      store.close();
    }
  }
  return runStandaloneSession(dir, {
    text: () => LEARN_REPORT,
    reason: "capex:learn",
    banner: (model) => `learning session (model ${model}) — exploring ${dir.project}…`,
  });
}

/** `endo capex [ask]` when the agent is not running: the session in-process. */
export async function cmdCapexStandalone(dir: AgentDir, ask?: string): Promise<number> {
  return runStandaloneSession(dir, {
    text: (world) => capexReport(ask, world.historyLength()),
    reason: "capex:session",
    banner: (model) => `research session (model ${model}) — reviewing ${dir.name}'s history…`,
  });
}

async function runStandaloneSession(
  dir: AgentDir,
  session: { text: (world: World) => string; reason: string; banner: (model: string) => string },
): Promise<number> {
  ensureAgentSkeleton(dir);
  const config = await loadConfig(dir.configPath);
  const before = new Map(
    (await loadPlaybook(dir.playbookDir)).map((e) => [e.name, e]),
  );

  let playbook = [...before.values()];
  const reload = async () => {
    playbook = await loadPlaybook(dir.playbookDir);
  };
  const { world, store, runtime } = await openJudgedWorld(dir, config, reload);
  runtime.bind({
    verbs: new Map(),
    projectDir: dir.project,
    agentDir: dir.root,
    playbookDir: dir.playbookDir,
    playbook: () => playbook,
    onPlaybookChanged: reload,
    record: (input, entries) => world.record({ at: Date.now(), ...input }, entries),
  });
  rolloverBudget(world, store, config);
  console.log(dim(session.banner(config.model.model)));
  const outcome = await activate(world, {
    text: session.text(world),
    reason: session.reason,
  });
  const spend = recordSpend(world, config, {
    reason: session.reason,
    execution: outcome.execution,
  });
  world.record({
    type: outcome.reason === "error" ? "escalation" : "judgment",
    summary: outcome.summary,
    at: Date.now(),
  });
  const compaction = runtime.takeCompactionRequest();
  if (compaction) {
    world.compact(compaction);
    console.log(dim(`history compacted to ${world.historyLength()} frames`));
  }
  world.snapshot();

  console.log(outcome.summary);
  if (spend) console.log(dim(`spent $${spend.usd.toFixed(3)} — ${describeBudget(spend.budget)}`));
  world.close();

  const after = await loadPlaybook(dir.playbookDir);
  const written = after.filter((e) => !before.has(e.name) || before.get(e.name)!.body !== e.body);
  if (written.length === 0) {
    console.error("\nno playbook entries were written — see frames above");
    return outcome.reason === "error" ? 1 : 0;
  }
  console.log(
    `\nplaybook entries written: ${written.map((e) => `${e.name} (${e.kind})`).join(", ")}` +
      ` — review ${dir.playbookDir}, then run \`endo up\``,
  );
  return 0;
}
