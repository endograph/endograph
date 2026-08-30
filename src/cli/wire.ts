import { AiSdkExecutor } from "@projectors/aisdk-executor";
import type { AgentDir } from "../agent/dir.ts";
import type { AgentConfig } from "../agent/config.ts";
import { buildJudgeActions } from "../judge/actions.ts";
import { composeInstructions } from "../judge/activate.ts";
import { languageModelFor } from "../judge/model.ts";
import { JudgeRuntime } from "../judge/runtime.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import type { FrameInput, FrameStore } from "../store/types.ts";
import { openWorld, type World } from "../world/world.ts";

/** An activation may run builds and deploys: give it hours, not seconds. */
const TURN_DEADLINE_MS = 2 * 60 * 60 * 1000;
const MAX_STEPS = 40;

/**
 * Open the agent's world with the judgment layer attached: charter.md as
 * the mandate in the system framing, judge tools on the agent node, and
 * projector's AI SDK executor over the granted model. The runtime must be
 * bound (verbs, playbook, inbox) before the first activation runs.
 */
export async function readCharter(dir: AgentDir): Promise<string | null> {
  const file = Bun.file(dir.charterPath);
  return (await file.exists()) ? await file.text() : null;
}

export function buildExecutor(config: AgentConfig): AiSdkExecutor {
  return new AiSdkExecutor({
    model: languageModelFor(config.model),
    maxSteps: MAX_STEPS,
    turnDeadlineMs: TURN_DEADLINE_MS,
    maxOutputTokens: 16000,
  });
}

export async function openJudgedWorld(
  dir: AgentDir,
  config: AgentConfig,
  onPlaybookChanged: () => Promise<void>,
  opts: { supervises?: boolean; onFrame?: (input: FrameInput) => void } = {},
): Promise<{ world: World; store: FrameStore; runtime: JudgeRuntime }> {
  const charterText = await readCharter(dir);

  const runtime = new JudgeRuntime();
  const store = openSqliteStore(dir.dbPath);
  const world = openWorld(store, {
    machineId: dir.name,
    instructions: composeInstructions(charterText),
    tools: buildJudgeActions(runtime, { supervises: opts.supervises }),
    onFrame: opts.onFrame,
    executor: buildExecutor(config),
  });
  // A minimal binding so standalone commands (learn) work; `up` rebinds
  // with the adapter's verbs and the inbox.
  runtime.bind({
    verbs: new Map(),
    projectDir: dir.project,
    agentDir: dir.root,
    playbookDir: dir.playbookDir,
    playbook: () => [],
    onPlaybookChanged,
    record: (input, entries) => world.record({ at: Date.now(), ...input }, entries),
  });
  return { world, store, runtime };
}
