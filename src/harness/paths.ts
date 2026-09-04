import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The agent directory and everything under `.endo/`, the state directory. */
export interface Paths {
  agentDir: string;
  grant: string;
  state: string;
  /** The grant as loaded: a copy under `.endo/`, so it resolves `endograph` like the program does. */
  grantCopy: string;
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
  workspace: string;
}

export function pathsOf(agentDir: string): Paths {
  const state = join(agentDir, ".endo");
  return {
    agentDir,
    grant: join(agentDir, "endograph.ts"),
    state,
    grantCopy: join(state, "grant.ts"),
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
    workspace: join(state, "workspace"),
  };
}

/** The endograph package that is running: what the state directory links. */
export const ENDOGRAPH_ROOT = resolve(import.meta.dir, "../..");

/**
 * The agent directory holds the owner's two files and nothing else. Every
 * dependency the program, the procedures, and the grant need is the one
 * package linked here by `endo up`, so they all resolve upward to it.
 */
export function ensureStateDir(paths: Paths): void {
  for (const dir of [paths.procedures, paths.inbox, paths.outbox, paths.runs, paths.snapshots, paths.modules]) mkdirSync(dir, { recursive: true });
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
  // For editors and `bunx tsc` in the agent directory: `endograph` resolves to the link. Written once; the owner's from then on.
  const tsconfig = join(paths.agentDir, "tsconfig.json");
  if (!existsSync(tsconfig)) writeFileSync(tsconfig, `${JSON.stringify(TSCONFIG, null, 2)}\n`);
}

const TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: ["./.endo/node_modules/endograph/node_modules/bun-types"],
    paths: { endograph: ["./.endo/node_modules/endograph/src/index.ts"], "endograph/procedure": ["./.endo/node_modules/endograph/src/procedures/lib.ts"] },
  },
  include: ["endograph.ts", ".endo/program", ".endo/src"],
};

/** Refresh the loadable copy of the grant. */
export function copyGrant(paths: Paths): string {
  copyFileSync(paths.grant, paths.grantCopy);
  return paths.grantCopy;
}
