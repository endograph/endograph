import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultWritePaths, SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { Grant } from "../grant/grant.ts";
import { ENDOGRAPH_ROOT, type Paths } from "../harness/paths.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : path;

/** One policy per outer process. Every program import and descendant runs under it. */
export async function sandboxCommand(paths: Paths, grant: Grant, argv: string[]): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  // Credentials are loaded explicitly by the host. Bun must not reload the
  // owner .env inside workers, where the file is intentionally unreadable.
  if (argv[0] === process.execPath) argv = [argv[0], "--no-env-file", ...argv.slice(1)];
  if (!grant.sandbox) return { argv, env: { ...process.env } };
  const policy = grant.sandbox;
  const forwarded = new Set(["PATH", "USER", "LANG", "TERM", ...policy.env]);
  const agentDir = canonical(paths.agentDir);
  const stateDir = canonical(paths.state);
  const hostDirectories = grant.hostModules.map((module) => {
    const file = resolve(agentDir, module);
    const directory = dirname(file);
    if (directory === agentDir || agentDir.startsWith(`${directory}/`) || directory === stateDir || directory.startsWith(`${stateDir}/`))
      throw new Error("sandbox host_modules must live in a dedicated owner directory outside .endo (for example host/sentry.ts)");
    if (canonical(directory) !== directory || canonical(file) !== file)
      throw new Error("sandbox host_modules must use direct paths, not symlinks");
    return directory;
  });
  const home = join(paths.state, "home");
  const temp = join(paths.state, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  // Linux needs an existing directory to mask before mounting the read-only tree.
  mkdirSync(join(paths.state, "codex"), { recursive: true, mode: 0o700 });
  const runtime = [ENDOGRAPH_ROOT, dirname(canonical(process.execPath)),
    dirname(fileURLToPath(import.meta.resolve("@endograph/codex-executor"))),
    dirname(fileURLToPath(import.meta.resolve("@projectors/core"))),
    dirname(fileURLToPath(import.meta.resolve("@projectors/aisdk-executor")))].map(canonical);
  // Linked packages resolve dependencies from their own ancestor node_modules.
  // Expose those dependency trees without opening the surrounding checkout.
  for (const root of [...runtime]) {
    for (let parent = root; dirname(parent) !== parent; parent = dirname(parent)) {
      const modules = join(parent, "node_modules");
      if (existsSync(modules)) runtime.push(canonical(modules));
    }
  }
  const ownerFiles = [paths.grant, ...(grant.manifest.path ? [grant.manifest.path] : []),
    ...hostDirectories];
  const ancestors = new Set<string>();
  if (process.platform === "darwin") for (const root of [paths.agentDir, resolve(paths.agentDir, grant.cwd), ...runtime]) {
    for (let parent = dirname(canonical(root)); dirname(parent) !== parent; parent = dirname(parent)) {
      // A one-character glob becomes an exact directory regex in Seatbelt,
      // allowing Bun's ancestor directory scans without opening their files.
      const directory = parent.replace(/([a-zA-Z0-9])([^a-zA-Z0-9]*)$/, "[$1]$2");
      ancestors.add(directory);
      ancestors.add(`${directory}/`);
      for (const name of ["package.json", "tsconfig.json"]) if (existsSync(join(parent, name))) ancestors.add(join(parent, name));
    }
  }
  const config: SandboxRuntimeConfig = {
    // Also tell SRT which inherited values are denied: its wrapper composes
    // variables such as JAVA_TOOL_OPTIONS before the filtered child starts.
    credentials: { envVars: Object.keys(process.env).filter((name) => !forwarded.has(name)).map((name) => ({ name, mode: "deny" })) },
    network: {
      allowedDomains: policy.network === "full" ? ["*"] : policy.network === "loopback" ? ["localhost", "127.0.0.1", "[::1]"] : policy.network === "offline" ? [] : policy.network,
      deniedDomains: policy.network === "offline" ? ["*"] : [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ["/", paths.env, join(paths.state, "codex"), ...hostDirectories],
      allowRead: ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/System", "/Library", "/dev", "/private/etc", "/etc", "/private/var/select",
        paths.agentDir, resolve(paths.agentDir, grant.cwd), ...runtime,
        ...policy.read.map((p) => resolve(paths.agentDir, p))].map(canonical).concat([...ancestors]),
      allowWrite: [paths.state, ...policy.write.map((p) => resolve(paths.agentDir, p))].map(canonical),
      denyWrite: [...ownerFiles, paths.env, join(paths.state, "codex"), join(paths.state, "program"), paths.modules,
        // SRT otherwise adds writable host temp/log directories implicitly.
        ...getDefaultWritePaths().filter((path) => !path.startsWith("/dev/")),
        join(ENDOGRAPH_ROOT, "src"), join(ENDOGRAPH_ROOT, "node_modules"), join(ENDOGRAPH_ROOT, "package.json"),
        ...runtime.filter((p) => p !== canonical(ENDOGRAPH_ROOT))].map(canonical),
    },
  };
  if (!SandboxManager.isSupportedPlatform()) throw new Error("sandboxing requires a supported macOS or Linux host");
  if (!SandboxManager.getConfig()) await SandboxManager.initialize(config);
  else SandboxManager.updateConfig(config);
  // SRT supplies a generic TMPDIR inside its wrapper; restore our private
  // runtime directories in the actual sandboxed command, after that wrapper.
  const command = ["/usr/bin/env", `HOME=${canonical(home)}`, `TMPDIR=${canonical(temp)}`, "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    ...argv.map((arg) => arg.startsWith("/") ? canonical(arg) : arg)];
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command.map(quote).join(" "), "/bin/sh", config, undefined, canonical(paths.agentDir));
  const env: NodeJS.ProcessEnv = {};
  for (const key of forwarded) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.HOME = canonical(home);
  env.TMPDIR = canonical(temp);
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
  // Only the wrapper's own transport variables are added, never the parent's credentials.
  for (const [key, value] of Object.entries(wrapped.env)) {
    if (value !== process.env[key]) env[key] = value;
  }
  return { argv: wrapped.argv, env };
}

export async function closeSandbox(): Promise<void> { await SandboxManager.reset(); }
