// Runs one command under its own sandbox policy: `bun sandbox-child.ts <policy json> <cwd> <argv...>`.
// SRT's network proxy reads one process-wide policy per connection, so a policy
// set in the host would also apply to its running sandboxed worker. This process
// owns its own policy and proxy, and exits with the command.
import { SandboxManager, type SandboxRuntimeConfig } from "@endograph/sandbox-runtime";
import { shellQuote } from "../harness/shell.ts";

const [policy, cwd, ...argv] = process.argv.slice(2);
const config = JSON.parse(policy!) as SandboxRuntimeConfig;
await SandboxManager.initialize(config);
const wrapped = await SandboxManager.wrapWithSandboxArgv(argv.map(shellQuote).join(" "), "/bin/sh", config, undefined, cwd);
const child = Bun.spawn(wrapped.argv, { cwd, stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...wrapped.env } });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
await child.exited;
await SandboxManager.reset();
process.exit(child.exitCode ?? 1);
