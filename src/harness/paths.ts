import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The agent directory and everything under `.endo/`, the state directory. */
export interface Paths {
  agentDir: string;
  /** `endograph.toml` */
  grant: string;
  state: string;
  /** Host-owned machine-local state; excluded from Git and snapshots. */
  local: string;
  /** `.endo/node_modules/endograph` links the endograph that runs the agent. */
  modules: string;
  lock: string;
  db: string;
  /** Owner-managed `.env` beside endograph.toml; KEY=VALUE credentials loaded at start. */
  env: string;
  log: string;
  program: string;
  src: string;
  procedures: string;
  inbox: string;
  outbox: string;
  /** Per-run files while a procedure runs: <id>.json, .out, .err, .exit. */
  runs: string;
  status: string;
  snapshots: string;
  /** Per inception: the workspace as read and every round's output, writes, and errors; kept on failure. */
  inceptions: string;
  workspace: string;
}

export function pathsOf(agentDir: string): Paths {
  const state = join(agentDir, ".endo");
  return {
    agentDir,
    grant: join(agentDir, "endograph.toml"),
    state,
    local: join(state, "local"),
    modules: join(state, "node_modules"),
    lock: join(state, "lock"),
    db: join(state, "agent.db"),
    env: join(agentDir, ".env"),
    log: join(state, "endo.log"),
    program: join(state, "program", "agent.ts"),
    src: join(state, "src"),
    procedures: join(state, "src", "procedures"),
    inbox: join(state, "inbox"),
    outbox: join(state, "outbox"),
    runs: join(state, "runs"),
    status: join(state, "status.json"),
    snapshots: join(state, "snapshots"),
    inceptions: join(state, "inceptions"),
    workspace: join(state, "workspace"),
  };
}

/** The endograph package that is running: what the state directory links. */
export const ENDOGRAPH_ROOT = resolve(import.meta.dir, "../..");

/**
 * The agent directory holds the owner's configuration, manifest, and credentials. The
 * one dependency the program and the procedures need is the package
 * linked here by `endo up`, so they resolve upward to it; a tsconfig
 * beside the link lets an editor and `bunx tsc` do the same.
 *
 * Immutable frame commits under frames/ include instance checkpoints;
 * SQLite can rebuild from those files. Copy the archive along with program,
 * src, snapshots and owner inputs. The runtime database and lock are local.
 * `.gitignore` is written once and belongs to the owner afterward.
 */
export function ensureStateDir(paths: Paths): void {
  for (const dir of [paths.procedures, paths.inbox, paths.outbox, paths.runs, paths.snapshots, paths.modules]) mkdirSync(dir, { recursive: true });
  const ignore = join(paths.state, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
  const link = join(paths.modules, "endograph");
  let current: string | undefined;
  try {
    current = readlinkSync(link);
  } catch {}
  if (current !== ENDOGRAPH_ROOT) {
    try {
      if (lstatSync(link)) rmSync(link, { recursive: true, force: true });
    } catch {}
    symlinkSync(ENDOGRAPH_ROOT, link);
  }
  writeFileSync(join(paths.state, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
}

/** `.endo/tsconfig.json`: the program and src typecheck against the linked endograph. Tooling, rewritten at every start. */
const GITIGNORE = `# host-owned machine-local state, including executor sessions
/local/
# relinked by every \`endo up\`
node_modules
# rebuilt from immutable frames/ on this machine
agent.db
agent.db-wal
agent.db-shm
# process ownership is local to this machine
lock
lock-journal
`;

const TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    // Resolve from Endograph so hoisted and isolated installs both work.
    types: [Bun.resolveSync("@types/bun/index.d.ts", ENDOGRAPH_ROOT)],
  },
  include: ["program", "src"],
};
