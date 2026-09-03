import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activate as driveActivation, asOutcome, type ActivationOutcome, type ActivationTrigger } from "../judge/activate.ts";
import { composeInstructions, driftReport } from "../judge/prompts.ts";
import { Loop, type JudgeContext } from "../loop/loop.ts";
import type { Drift, Outcome } from "../loop/types.ts";
import { procedureAction, procedureSignature } from "../playbook/actions.ts";
import { loadPlaybook } from "../playbook/parse.ts";
import type { PlaybookEntry, Procedure } from "../playbook/types.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import type { FrameInput } from "../store/types.ts";
import { MigrationFailed, openWorld, type World } from "../world/world.ts";
import { acquireLock, DECLARATION_FILE, loadEnv, type HomePaths } from "./home.ts";
import { readMandate, type LoadedDeclaration } from "./load.ts";
import { claim } from "./registry.ts";
import type { RuntimeContext } from "./runtime.ts";

/**
 * A running agent: store, world, batteries bound, the loop, the judgment
 * seam, one activation at a time. `endo up` starts the loop; `learn` and
 * `capex` open the agent for a single activation.
 */

export interface OpenOptions {
  home: HomePaths;
  loaded: LoadedDeclaration;
  onFrame?: (input: FrameInput) => void;
}

export interface RunningAgent {
  ctx: RuntimeContext;
  /** Start sensors, reloads, and ticks. Non-blocking. */
  start(): void;
  stop(): Promise<void>;
  /** A standing session by name ("learn", "capex"), with an optional ask. */
  session(name: string, ask?: string): Promise<ActivationOutcome>;
}

export class AlreadyRunning extends Error {
  constructor(home: string) {
    super(`agent at ${home} is already running`);
  }
}

export async function openAgent(opts: OpenOptions): Promise<RunningAgent> {
  const { home, loaded } = opts;
  const { definition } = loaded;
  loadEnv(home.envPath);
  const lock = acquireLock(home.lockPath);
  if (!lock) throw new AlreadyRunning(home.root);
  try {
    claim(definition.name, home.root);
  } catch (err) {
    lock.release();
    throw err;
  }

  const store = openSqliteStore(home.dbPath);
  const mandate = await readMandate(loaded.mandatePath);
  const executor = definition.executor?.create();
  const scripts = { cwd: loaded.cwd, home: home.root, src: home.srcDir };
  const record: RuntimeContext["record"] = (input, patch) => world.record({ at: Date.now(), ...input }, patch);

  // The playbook's procedures compile to typed actions: tools for the model,
  // and (exposed) commands for peers. A change to that surface rebuilds the
  // charter — only between activations.
  let entries: PlaybookEntry[] = [];
  let playbookProblem: string | undefined;
  let surface = "";
  let rebuildWanted = false;
  const staticNames = new Set(definition.tools.map((t) => t.name));
  const compileProcedures = () => {
    const tools = [...definition.tools];
    const commands = [];
    for (const p of entries.filter((e): e is Procedure => e.kind === "procedure")) {
      if (staticNames.has(p.name)) {
        record({ type: "error", subject: `playbook:${p.name}`, summary: `procedure "${p.name}" shadows a built-in tool and is not compiled` });
        continue;
      }
      const action = procedureAction(p, () => scripts);
      if (p.expose) commands.push(action);
      else tools.push(action);
    }
    return { tools, commands };
  };
  const reloadPlaybook = async () => {
    try {
      entries = await loadPlaybook(home.srcDir);
      if (playbookProblem) {
        playbookProblem = undefined;
        record({ type: "note", subject: "playbook", summary: "playbook loads again" });
      }
      const next = procedureSignature(entries);
      if (next !== surface) {
        surface = next;
        rebuildWanted = true;
        await applyRebuild();
      }
    } catch (err) {
      // Reloads run every few seconds; say it once per distinct problem.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== playbookProblem) {
        playbookProblem = message;
        record({ type: "error", subject: "playbook", summary: `playbook not reloaded (previous entries stay live): ${message}` });
      }
    }
  };
  let pendingInstructions: string | undefined;
  let activating = false;
  /** Rebuild the machine only when no activation is driving it. */
  const applyRebuild = async () => {
    if (activating || !worldRef) return;
    if (!rebuildWanted && pendingInstructions === undefined) return;
    const patch: Parameters<World["reconfigure"]>[0] = {};
    if (rebuildWanted) Object.assign(patch, compileProcedures());
    if (pendingInstructions !== undefined) patch.instructions = pendingInstructions;
    rebuildWanted = false;
    pendingInstructions = undefined;
    try {
      await worldRef.reconfigure(patch);
    } catch (err) {
      if (err instanceof MigrationFailed) return giveUp(err);
      throw err;
    }
    if (patch.tools) record({ type: "note", subject: "playbook", summary: `tools: ${patch.tools.map((t) => t.name).join(", ")}${patch.commands?.length ? `; exposed: ${patch.commands.map((c) => c.name).join(", ")}` : ""}` });
  };
  /** After MAX_MIGRATIONS failed migrations: leave a marker for doctor and stop cleanly (no crash loop). */
  const giveUp = (err: MigrationFailed) => {
    writeFileSync(home.needsHumanPath, `${new Date().toISOString()}\n${err.message}\n`);
    console.error(`${err.message}\nstopping; fix the declaration or playbook and run \`endo up\`, or \`endo reset --force\` (see endo doctor)`);
    lock.release();
    process.exit(0);
  };

  await (async () => {
    try {
      entries = await loadPlaybook(home.srcDir);
    } catch (err) {
      playbookProblem = err instanceof Error ? err.message : String(err);
    }
  })();
  surface = procedureSignature(entries);
  const initial = compileProcedures();
  let worldRef: World | undefined;
  let world: World;
  try {
    world = await openWorld(store, {
    machineId: definition.name,
    instructions: composeInstructions(mandate, { evolvable: definition.evolvable }),
    tools: initial.tools,
    commands: initial.commands,
    states: definition.states,
    children: definition.children,
    childActions: definition.childActions,
    executor,
    executorConfig: definition.executor?.executorConfig,
    runner: { home: home.root, pid: process.pid },
    onFrame: opts.onFrame,
    onStoreError: (err) => {
      // The log is the agent. Exit unsuccessfully so a supervisor restarts us on a fresh file handle.
      console.error(`frame store failed: ${err instanceof Error ? err.message : err} — stopping`);
      lock.release();
      process.exit(1);
    },
    });
  } catch (err) {
    if (err instanceof MigrationFailed) {
      writeFileSync(home.needsHumanPath, `${new Date().toISOString()}\n${err.message}\n`);
      lock.release();
      throw err;
    }
    throw err;
  }
  worldRef = world;
  rmSync(home.needsHumanPath, { force: true });
  if (playbookProblem) record({ type: "error", subject: "playbook", summary: `playbook did not load: ${playbookProblem}` });

  // One activation at a time; batteries queue standing sessions behind the current one.
  let compaction: string | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const activate = (a: { text: string; trigger: ActivationTrigger }): Promise<ActivationOutcome> => {
    const run = async () => {
      activating = true;
      let outcome: ActivationOutcome;
      try {
        outcome = await driveActivation(world, a);
      } finally {
        activating = false;
      }
      for (const b of definition.batteries) {
        try {
          await b.hooks?.afterActivation?.(outcome);
        } catch (err) {
          record({ type: "error", subject: `battery:${b.name}`, summary: `afterActivation failed: ${err instanceof Error ? err.message : err}` });
        }
      }
      if (compaction) {
        const summary = compaction;
        compaction = undefined;
        world.compact(summary);
      }
      await applyRebuild();
      return outcome;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  const ctx: RuntimeContext = {
    name: definition.name,
    home,
    scripts,
    store,
    world,
    playbook: () => entries,
    reloadPlaybook,
    record,
    session: (name, ask) => session(name, ask),
    requestCompaction: (summary) => (compaction = summary),
    executorModel: definition.executor?.model,
    executorPrice: definition.executor?.price,
  };
  definition.bind(ctx);

  const session = (name: string, ask?: string): Promise<ActivationOutcome> => {
    const spec = definition.sessions[name];
    if (!spec) return Promise.reject(new Error(`unknown session "${name}"; known: ${Object.keys(definition.sessions).join(", ") || "(none)"}`));
    return activate({ text: spec.prompt(ask, ctx), trigger: { kind: "session", session: name } });
  };

  const judge = async (drift: Drift, incident: string, context: JudgeContext): Promise<Outcome> => {
    const ruleNames = entries.filter((e) => e.kind === "rule").map((e) => e.name);
    const outcome = await activate({
      text: driftReport(drift, ruleNames, context.ruleFailure),
      trigger: { kind: "drift", drift: drift.kind, incident },
    });
    return asOutcome(outcome);
  };

  const loop = new Loop({
    world,
    sensors: definition.batteries.flatMap((b) => b.sensors ?? []),
    playbook: () => entries,
    scripts: ctx.scripts,
    judge: executor ? judge : undefined,
    onSettle: (drift, outcome) => {
      for (const b of definition.batteries) b.hooks?.onSettle?.(drift, outcome);
    },
  });

  const timers: Timer[] = [];
  let mandateMtime = mtime(loaded.mandatePath);
  const declarationFile = join(loaded.dir, DECLARATION_FILE);
  let declarationMtime = mtime(declarationFile);
  let warnedDeclaration = false;

  const agent: RunningAgent = {
    ctx,
    session,
    start() {
      loop.start();
      const drain = () => {
        // On the activation chain so a drain never overlaps a run.
        chain = chain.then(() => world.drain().catch((err) => record({ type: "error", subject: "machine", summary: `drain failed: ${err instanceof Error ? err.message : err}` })));
      };
      drain();
      timers.push(
        setInterval(drain, 5_000),
        setInterval(() => void reloadPlaybook(), 5_000),
        setInterval(async () => {
          if (!existsSync(home.root)) {
            record({ type: "error", subject: "home", summary: `home ${home.root} is gone (moved?); stopping — run \`endo up\` from its new location` });
            await agent.stop();
            process.exit(0);
          }
          const m = mtime(loaded.mandatePath);
          if (m !== mandateMtime) {
            mandateMtime = m;
            pendingInstructions = composeInstructions(await readMandate(loaded.mandatePath), { evolvable: definition.evolvable });
            record({ type: "note", subject: "mandate", summary: "mandate reloaded" });
            await applyRebuild();
          }
          const d = mtime(declarationFile);
          if (d !== declarationMtime && !warnedDeclaration) {
            warnedDeclaration = true;
            record({ type: "note", subject: "declaration", summary: `${DECLARATION_FILE} changed; restart (endo up -d) to apply` });
          }
        }, 5_000),
        setInterval(async () => {
          for (const b of definition.batteries) {
            try {
              await b.hooks?.tick?.(Date.now());
            } catch (err) {
              record({ type: "error", subject: `battery:${b.name}`, summary: `tick failed: ${err instanceof Error ? err.message : err}` });
            }
          }
        }, 60_000),
      );
    },
    async stop() {
      // An in-flight activation is abandoned: its frames so far are recorded,
      // and any request it left open gets the restart-recovery reply next start.
      timers.forEach(clearInterval);
      await loop.stop();
      world.close();
      lock.release();
    },
  };
  return agent;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
