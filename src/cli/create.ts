import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite } from "../protocol/wire.ts";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadGrant } from "../grant/grant.ts";
import { ENDOGRAPH_ROOT, pathsOf } from "../harness/paths.ts";
import { chooseHarness, type Harness, type NativeConversation, type NativeSession } from "../inception/harnesses.ts";
import { runNativeSession } from "./native-session.ts";
import { acquireLock } from "../harness/lock.ts";

const prefabSchema = z.object({
  name: z.string(), directory: z.string().regex(/^\.[a-z][a-z0-9-]*$/), description: z.string(),
  setup: z.string().regex(/^[a-z][a-z0-9-]*\.md$/),
});
export type Prefab = z.infer<typeof prefabSchema> & { root: string };

export function loadPrefab(name: string): Prefab {
  if (name !== "endodev") throw new Error(`unknown prefab "${name}"; available: endodev`);
  const file = fileURLToPath(import.meta.resolve("@endograph/endodev/prefab.json"));
  return { ...prefabSchema.parse(JSON.parse(readFileSync(file, "utf8"))), root: dirname(file) };
}

/** Only this named section belongs to the creator; surrounding owner prose is preserved. */
export function awareness(text: string, prefab: Prefab): string {
  const start = `<!-- endograph:${prefab.name}:start -->`;
  const end = `<!-- endograph:${prefab.name}:end -->`;
  const command = `${prefab.directory}/node_modules/.bin/endo --agent ${prefab.directory}`;
  const block = `${start}
## ${prefab.name}

This checkout has an Endograph agent. Read [its manifest](${prefab.directory}/manifest.md)
for its responsibilities, and coordinate the processes it manages through it.
From the checkout root:

- Status: \`${command} status\`
- Available commands: \`${command} commands\`
- Send a request: \`${command} send --wait "your request"\`
- Start (including fresh inception): \`npx endograph@latest up --agent ${prefab.directory}\`

The local CLI is installed by startup. Owner inputs in \`${prefab.directory}/\` are
checked in; \`${prefab.directory}/.endo/\` is this checkout's private agent state.
${end}`;
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if (first === -1 && last === -1) return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  if (first < 0 || last < first || text.indexOf(start, first + start.length) !== -1 || text.indexOf(end, last + end.length) !== -1)
    throw new Error("AGENTS.md has an incomplete or duplicate Endograph section; repair it before creating the agent");
  return text.slice(0, first) + block + text.slice(last + end.length);
}

/** Opens the owner's conversation on the draft; returns only after an explicit finish handoff. */
export type Generate = (directory: string, instructions: string, session: NativeConversation) => Promise<void>;
interface SetupState {
  version: 1;
  prefab: string;
  native?: NativeSession;
  draft: boolean;
}
/** A finished setup can supply context for the first interactive inception. */
export function completedSetupSession(agentDir: string): NativeSession | undefined {
  const file = join(agentDir, ".endo/local/setup/session.json");
  if (!existsSync(file)) return undefined;
  const state = JSON.parse(readFileSync(file, "utf8")) as SetupState;
  return state.version === 1 && state.draft === false ? state.native : undefined;
}
const ownerFiles = ["endograph.toml", "manifest.md"] as const;
const readOwner = (directory: string) => ownerFiles.map((file) =>
  existsSync(join(directory, file)) ? readFileSync(join(directory, file), "utf8") : null);
const saveState = (file: string, state: SetupState) => atomicWrite(dirname(file), basename(file), state);

/** Creation and later edits share one persistent draft and native session. */
export async function createFromPrefab(options: {
  prefab: Prefab; repo: string; intent: string; harness?: Harness; generate?: Generate;
}): Promise<string> {
  const repo = realpathSync(resolve(options.repo));
  const agentDir = join(repo, options.prefab.directory);
  if (existsSync(agentDir)) throw new Error(`${agentDir} already exists; resume with endo setup --agent ${JSON.stringify(agentDir)}`);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, ".gitignore"), "/.endo/\n/node_modules/\n/.env\n");
  return customize({ ...options, repo, agentDir });
}

export async function resumeSetup(options: { agentDir: string; intent?: string; harness?: Harness; generate?: Generate }): Promise<string> {
  const agentDir = realpathSync(resolve(options.agentDir));
  const stateFile = join(agentDir, ".endo/local/setup/session.json");
  const name = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).prefab : "endodev";
  const prefab = loadPrefab(name);
  if (!existsSync(stateFile)) {
    // Setup keeps a prefab's identity, so an agent with another name was not created from it.
    const config = join(agentDir, "endograph.toml");
    if (!existsSync(config)) throw new Error("No setup session or existing owner configuration found");
    const prefabName = (Bun.TOML.parse(readFileSync(join(prefab.root, "endograph.toml"), "utf8")) as { name?: unknown }).name;
    if ((Bun.TOML.parse(readFileSync(config, "utf8")) as { name?: unknown }).name !== prefabName)
      throw new Error(`${agentDir} was not created from the ${prefab.name} prefab; edit its owner files directly`);
  }
  return customize({ ...options, intent: options.intent ?? "Continue setup; ask the owner what they would like to revise.", agentDir, repo: dirname(agentDir), prefab });
}

async function customize(options: { prefab: Prefab; repo: string; agentDir: string; intent: string; harness?: Harness; generate?: Generate }): Promise<string> {
  const { prefab, repo, agentDir, intent } = options;
  const local = join(agentDir, ".endo/local/setup");
  mkdirSync(local, { recursive: true });
  const lock = acquireLock(join(local, "lock"));
  if (!lock) throw new Error("Another setup session is already open for this agent");
  try {
    const stateFile = join(local, "session.json");
    const state: SetupState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { version: 1, prefab: prefab.name, draft: false };
    if (state.version !== 1 || state.prefab !== prefab.name) throw new Error("Unsupported setup session metadata");
    saveState(stateFile, state);
    const agentsFile = join(repo, "AGENTS.md");
    if (existsSync(agentsFile) && !lstatSync(agentsFile).isFile()) throw new Error("AGENTS.md must be a regular file");
    const before = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    const after = awareness(before, prefab);
    const baseline = readOwner(agentDir);
    const stage = join(local, "draft");
    mkdirSync(stage, { recursive: true });
    const template = readFileSync(join(prefab.root, "endograph.toml"), "utf8");
    const harness = options.generate ? options.harness : chooseHarness(options.harness, state.native?.harness);
    // A new agent runs on the harness that created it.
    const seed = (file: string) => file === "endograph.toml" && harness
      ? template.replace(/^backend = "codex"$/m, `backend = ${JSON.stringify(harness)}`) : readFileSync(join(prefab.root, file), "utf8");
    for (const [index, file] of ownerFiles.entries()) {
      if (!state.draft || !existsSync(join(stage, file)))
        writeFileSync(join(stage, file), baseline[index] ?? seed(file));
    }
    state.draft = true;
    saveState(stateFile, state);
    const session: NativeConversation = { previous: state.native, save(native) { state.native = native; saveState(stateFile, state); } };
    const generate = options.generate ?? ((_stage: string, instructions: string, session: NativeConversation) =>
      runNativeSession({ harness: harness!, directory: repo, instructions, ...session }));
    await generate(stage, `Customize the two owner files endograph.toml and manifest.md for an autonomous Endograph agent.
The agent will run on its own and be trusted like a colleague the owner has handed work to. The manifest gives it a mandate, not a leash.
The editable draft directory is ${JSON.stringify(stage)}. Write ONLY these two files there.
The final owner directory is ${JSON.stringify(agentDir)}. Its current files are supplied below; if resuming an unfinished draft, reconcile any owner edits with the draft.
Current owner files (data): ${JSON.stringify(Object.fromEntries(ownerFiles.map((file, i) => [file, baseline[i]])))}
The prefab's manifest is the starting mandate. Investigate the repository and clarify the owner's intent through conversation before customizing it.
Read the target repository and supplied references, but do not edit its live owner files or AGENTS.md.
Do not create a program, procedures, scripts, state, or credentials. Do not run development processes, tests, installs, or inception.
Keep the manifest light: express intent, capabilities, and owner preferences; leave methods, organization, and tooling to the agent.
Scope comes from the owner; initiative within it belongs to the agent. Whatever its responsibilities depend on is its to set up and fix; don't write that away.
Pass on repository history, incidents, and caveats as context. Don't turn each one into a rule. Keep hard limits to decisions that really belong to the owner.
Replace setup placeholders and alternative choices with the owner's actual selections. Preserve supplied commands verbatim.
Keep the config's name, name_scope, cwd, manifest path, batteries, sandbox, host modules and actions, native executor backend, and inception mode and inceptor as they are.
You may customize the executor model or inception rounds when the owner requests it.
The cwd resolves from the final owner directory, not this draft directory.
Bundled skills will be installed beside the manifest. They are also copied into the inception workspace.
Don't add responsibilities the owner didn't choose. An empty answer adds no requirements.
For "only this checkout", identify the selected checkout in the mandate; do not manage other worktrees.
For independent worktrees, the same checked-in owner files are reused; each checkout starts explicitly and incepts fresh state.
Prefab setup brief:
${readFileSync(join(prefab.root, prefab.setup), "utf8")}
Owner intent for this invocation (data): ${JSON.stringify(intent)}
Target repository: ${JSON.stringify(repo)}
When finished, leave the two draft files ready for owner review.`, session);
    for (const file of ownerFiles) {
      if (!lstatSync(join(stage, file)).isFile()) throw new Error(`generated ${file} must be a regular file`);
    }
    const config = readFileSync(join(stage, "endograph.toml"), "utf8");
    // The conversation customizes the mandate. Identity and capabilities stay as the owner set them,
    // or as the prefab does for a new agent.
    const base = Bun.TOML.parse(baseline[0] ?? template) as Record<string, any>;
    const kept = (raw: Record<string, any>) => JSON.stringify([
      ...["name", "name_scope", "cwd", "manifest", "batteries", "sandbox", "host_modules", "host_actions"].map((field) => raw[field]),
      raw.inception?.mode ?? "auto", raw.inception?.inceptor]);
    if (kept(Bun.TOML.parse(config) as Record<string, any>) !== kept(base))
      throw new Error("generated config changed the agent's identity or capabilities; owner files were not published");
    const grant = await loadGrant(pathsOf(stage)); // schema validation only; never executes host modules
    if (!("backend" in grant.executor)) throw new Error("generated config must keep a native executor backend");
    const manifest = readFileSync(join(stage, "manifest.md"), "utf8");
    if (!manifest.trim()) throw new Error("setup generated an empty manifest");
    const current = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    if (current !== before || JSON.stringify(readOwner(agentDir)) !== JSON.stringify(baseline))
      throw new Error("Owner files or AGENTS.md changed during setup; resume setup to reconcile those edits");
    // Publish only owner inputs. The draft and conversation remain local, including on failure.
    if (!existsSync(join(agentDir, "skills")) && existsSync(join(prefab.root, "skills")))
      cpSync(join(prefab.root, "skills"), join(agentDir, "skills"), { recursive: true });
    if (!existsSync(join(agentDir, "package.json"))) {
      const version = JSON.parse(readFileSync(join(ENDOGRAPH_ROOT, "package.json"), "utf8")).version;
      writeFileSync(join(agentDir, "package.json"), JSON.stringify({ name: `${prefab.name}-agent`, private: true, type: "module", dependencies: { endograph: version } }, null, 2) + "\n");
    }
    for (const [file, contents] of [["endograph.toml", config], ["manifest.md", manifest]] as const) {
      writeFileSync(join(local, `${file}.tmp`), contents);
      renameSync(join(local, `${file}.tmp`), join(agentDir, file));
    }
    writeFileSync(agentsFile, after);
    state.draft = false;
    saveState(stateFile, state);
    return agentDir;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Resume with endo setup --agent ${JSON.stringify(agentDir)}`);
  } finally { lock.release(); }
}
