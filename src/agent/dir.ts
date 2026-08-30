import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * An agent is any directory containing `endograph.toml`. The conventional
 * directory name is `.{name}`, but identity is structural, not path-based.
 * Config is the grant, charter is the mandate,
 * `src/` is the experience (agent-writable, starts empty), `inbox/` is
 * where peers leave requests.
 */
export interface AgentDir {
  /** Agent name, derived from the directory basename (without a leading dot). */
  name: string;
  /** Absolute path of the agent directory. */
  root: string;
  /** Project directory the agent lives in (parent of root). */
  project: string;
  configPath: string;
  charterPath: string;
  dbPath: string;
  srcDir: string;
  playbookDir: string;
  sandboxDir: string;
  inboxDir: string;
  /** Optional KEY=VALUE file of credentials, loaded into the environment. */
  envPath: string;
}

const CONFIG_FILE = "endograph.toml";

function hasConfig(root: string): boolean {
  const path = join(root, CONFIG_FILE);
  return existsSync(path) && statSync(path).isFile();
}

export function agentDirAt(project: string, name: string): AgentDir {
  return agentDirFromRoot(resolve(project, `.${name}`));
}

export function agentDirFromRoot(rootPath: string): AgentDir {
  const root = resolve(rootPath);
  const base = basename(root);
  const configPath = join(root, CONFIG_FILE);
  if (!hasConfig(root)) {
    throw new Error(`${root} is not an agent directory (missing ${CONFIG_FILE})`);
  }
  return {
    name: base.startsWith(".") ? base.slice(1) : base,
    root,
    project: dirname(root),
    configPath,
    charterPath: join(root, "charter.md"),
    dbPath: join(root, "agent.db"),
    srcDir: join(root, "src"),
    playbookDir: join(root, "src", "playbook"),
    sandboxDir: join(root, "src", "sandbox"),
    inboxDir: join(root, "inbox"),
    envPath: join(root, "env"),
  };
}

/**
 * Credentials come from the environment; the agent's `env` file is a
 * convenient, git-ignored place to keep them next to the agent. Lines are
 * KEY=VALUE (optional `export `, optional quotes); the real environment
 * wins over the file.
 */
export function loadAgentEnv(dir: AgentDir): void {
  if (!existsSync(dir.envPath)) return;
  const text = readFileSync(dir.envPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

/** List immediate child directories containing an endograph config. */
export function listAgentDirs(project: string): AgentDir[] {
  const dir = resolve(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && hasConfig(join(dir, e.name)))
    .map((e) => agentDirFromRoot(join(dir, e.name)));
}

/**
 * Resolve the agent to operate on. `--agent` (or ENDO_AGENT) may be a name
 * in the current project or a path to the agent directory — peers in other
 * checkouts address an agent by path. Otherwise the single agent in the
 * project; multiple agents without a name is an error.
 */
export function resolveAgentDir(project: string, nameOrPath?: string): AgentDir {
  const target = nameOrPath ?? process.env.ENDO_AGENT;
  if (target) {
    const looksLikePath =
      target.includes("/") || target.startsWith(".") || target.startsWith("~");
    const dir = looksLikePath
      ? agentDirFromRoot(expandHome(target))
      : agentDirAt(project, target);
    if (!existsSync(dir.root)) {
      throw new Error(`no agent directory ${dir.root}`);
    }
    return dir;
  }
  const all = listAgentDirs(project);
  if (all.length === 0) {
    throw new Error(
      `no directory containing ${CONFIG_FILE} in ${resolve(project)} — create one (see template) ` +
        `or pass --agent <path>`,
    );
  }
  if (all.length > 1) {
    throw new Error(
      `multiple agents (${all.map((d) => d.name).join(", ")}) — pass --agent <name>`,
    );
  }
  return all[0]!;
}

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** Ensure the agent-writable skeleton exists (src/, playbook/, sandbox/, inbox/). */
export function ensureAgentSkeleton(dir: AgentDir): void {
  mkdirSync(dir.playbookDir, { recursive: true });
  mkdirSync(dir.sandboxDir, { recursive: true });
  mkdirSync(dir.inboxDir, { recursive: true });
}
