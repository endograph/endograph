import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@endograph/sandbox-runtime";
import { canonical, type Paths } from "../harness/paths.ts";
import type { Grant } from "../grant/grant.ts";

const child = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url));

/**
 * Headless authors receive copies of owner inputs, never write access to originals.
 * The policy runs in its own process: the host's SandboxManager belongs to the agent's worker.
 */
export function protectInceptor(paths: Paths, grant: Grant, candidate: string, argv: string[]): { argv: string[]; env: NodeJS.ProcessEnv } {
  const live = [paths.grant, paths.env, ...(grant.manifest.path ? [grant.manifest.path] : [])].map(canonical);
  const copies = [join(candidate, "endograph.toml"), join(candidate, "manifest.md"), join(candidate, ".endo/workspace/MANIFEST.md")].map(canonical);
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: ["*"], deniedDomains: [], allowLocalBinding: true },
    filesystem: { denyRead: live, allowRead: [], allowWrite: ["/"], denyWrite: [...live, ...copies] },
  };
  if (!SandboxManager.isSupportedPlatform()) throw new Error("headless inception requires a supported macOS or Linux sandbox");
  return { argv: [process.execPath, "--no-env-file", child, JSON.stringify(config), canonical(candidate), ...argv], env: {} };
}
