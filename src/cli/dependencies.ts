import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../harness/lock.ts";

/** Owner-project dependencies are installed by the host, before loading agent code. */
export async function installDependencies(agentDir: string): Promise<void> {
  if (!existsSync(join(agentDir, "package.json"))) return;
  const lock = acquireLock(join(agentDir, ".endo", "lock"));
  if (!lock) throw new Error("cannot install dependencies while the agent is running; run `endo down` first");
  try {
    const bunLock = ["bun.lock", "bun.lockb"].some((file) => existsSync(join(agentDir, file)));
    const npmLock = ["package-lock.json", "npm-shrinkwrap.json"].some((file) => existsSync(join(agentDir, file)));
    const command = bunLock ? [process.execPath, "install", "--frozen-lockfile"]
      : npmLock ? ["npm", "ci"] : [process.execPath, "install"];
    console.log(`Installing dependencies in ${agentDir}${bunLock || npmLock ? " from the lockfile" : ""}`);
    const child = Bun.spawn(command, { cwd: agentDir, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) throw new Error(`dependency installation failed (exit ${code}); agent not started`);
  } finally { lock.release(); }
}
