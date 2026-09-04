import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The agent directory and everything under `.endo/`, the state directory. */
export interface Paths {
  agentDir: string;
  /** `endograph.toml` */
  grant: string;
  state: string;
  /** `.endo/node_modules/endograph` links the endograph that runs the agent. */
  modules: string;
  lock: string;
  db: string;
  /** KEY=VALUE credentials, mode 600; loaded at start. */
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
    modules: join(state, "node_modules"),
    lock: join(state, "lock"),
    db: join(state, "agent.db"),
    env: join(state, "env"),
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
 * The agent directory holds the owner's two files and nothing else. The
 * one dependency the program and the procedures need is the package
 * linked here by `endo up`, so they resolve upward to it; a tsconfig
 * beside the link lets an editor and `bunx tsc` do the same.
 *
 * The state directory is written so that a copy of it, taken at any
 * instant, is a valid state directory (the log is checkpointed at every
 * quiescence). Its `.gitignore` names what a copy should leave behind:
 * relinked on the next `up`, or meaningless off this machine. Written
 * once; the owner's from then on.
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
const GITIGNORE = `# relinked by every \`endo up\`
node_modules
# empty after every quiescence; only this machine's SQLite reads them
agent.db-wal
agent.db-shm
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
    types: ["./node_modules/endograph/node_modules/bun-types"],
  },
  include: ["program", "src"],
};
