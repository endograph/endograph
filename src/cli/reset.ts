import { existsSync, rmSync } from "node:fs";
import { ensureAgentSkeleton, type AgentDir } from "../agent/dir.ts";

/**
 * Factory-reset: keep the grant (endograph.toml) and mandate (charter.md),
 * wipe the experience (agent.db + src/). An escape hatch and testing tool,
 * not intended usage — the directory is a home directory.
 */
export async function cmdReset(dir: AgentDir, force: boolean): Promise<number> {
  if (!force) {
    console.error(
      `endo reset wipes ${dir.dbPath} and ${dir.srcDir} (the agent's entire ` +
        `learned experience), keeping endograph.toml and charter.md.\n` +
        `Re-run with --force to proceed.`,
    );
    return 1;
  }
  for (const path of [
    dir.dbPath,
    `${dir.dbPath}-wal`,
    `${dir.dbPath}-shm`,
    dir.srcDir,
  ]) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true });
      console.log(`removed ${path}`);
    }
  }
  ensureAgentSkeleton(dir);
  console.log(`agent "${dir.name}" reset to base config + charter`);
  return 0;
}
