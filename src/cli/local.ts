import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ENDOGRAPH_ROOT } from "../harness/paths.ts";

/** Prefer the owner's pinned installation over a global or npx cache copy. */
export function localCli(agentDir: string): string | null {
  const root = join(agentDir, "node_modules", "endograph");
  if (!existsSync(join(root, "package.json"))) return null;
  if (realpathSync(root) === realpathSync(ENDOGRAPH_ROOT)) return null;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.endo;
  if (typeof bin !== "string") throw new Error("local Endograph installation has no endo executable");
  const cli = resolve(root, bin);
  if (!cli.startsWith(resolve(root) + sep) || !existsSync(cli)) throw new Error("local Endograph executable is missing or invalid; reinstall dependencies");
  return cli;
}

export async function runLocal(agentDir: string, args: string[]): Promise<number | null> {
  const cli = localCli(agentDir);
  if (!cli) return null;
  const child = Bun.spawn([process.execPath, cli, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { return await child.exited; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
