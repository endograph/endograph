import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentDir } from "../agent/dir.ts";
import { dim } from "./shared.ts";

/**
 * `endo install|uninstall|restart` — the agent's home process. On macOS an
 * agent runs as a launchd user agent: started at login, relaunched if it
 * exits, in the owner's GUI session (keychain, ssh agent, unrestricted
 * network — the things a sandboxed shell lacks). Logs go to the agent dir.
 */

export function serviceLabel(dir: AgentDir): string {
  return `endo.${basename(dir.project)}.${dir.name}`;
}

export function servicePlistPath(dir: AgentDir): string {
  return join(homedir(), "Library", "LaunchAgents", `${serviceLabel(dir)}.plist`);
}

export function serviceLogPath(dir: AgentDir): string {
  return join(dir.root, `${dir.name}.log`);
}

/** The plist, built from how `endo` is being run right now (bun + this CLI). */
export function launchAgentPlist(
  dir: AgentDir,
  opts: { bun: string; cli: string; path: string; home: string },
): string {
  const args = [opts.bun, opts.cli, "--agent", dir.root, "up"];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(serviceLabel(dir))}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(dir.project)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(opts.path)}</string>
    <key>HOME</key>
    <string>${esc(opts.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${esc(serviceLogPath(dir))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(serviceLogPath(dir))}</string>
</dict>
</plist>
`;
}

export async function cmdInstall(dir: AgentDir): Promise<number> {
  requireMacOS();
  const plist = servicePlistPath(dir);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await Bun.write(
    plist,
    launchAgentPlist(dir, {
      bun: process.execPath,
      cli: Bun.main,
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: homedir(),
    }),
  );
  await bootout(dir); // idempotent: re-install replaces a running instance
  const err = await bootstrap(plist);
  if (err) {
    console.error(`installed ${plist} but launchd refused it: ${err}`);
    return 1;
  }
  console.log(`installed ${serviceLabel(dir)} — running now and at every login`);
  console.log(dim(`  plist ${plist}`));
  console.log(dim(`  log   ${serviceLogPath(dir)}`));
  return 0;
}

export async function cmdUninstall(dir: AgentDir): Promise<number> {
  requireMacOS();
  await bootout(dir);
  const plist = servicePlistPath(dir);
  if (existsSync(plist)) unlinkSync(plist);
  console.log(`uninstalled ${serviceLabel(dir)}`);
  return 0;
}

/** Stop and start the home process: picks up new endograph code. (Charter, grant, and playbook reload live without this.) */
export async function cmdRestart(dir: AgentDir): Promise<number> {
  requireMacOS();
  const plist = servicePlistPath(dir);
  if (!existsSync(plist)) {
    console.error(`${serviceLabel(dir)} is not installed — run \`endo install\``);
    return 1;
  }
  await bootout(dir);
  const err = await bootstrap(plist);
  if (err) {
    console.error(`restart failed: ${err}`);
    return 1;
  }
  console.log(`restarted ${serviceLabel(dir)}`);
  return 0;
}

function requireMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("endo install/uninstall/restart use launchd and need macOS");
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function launchctl(args: string[]): Promise<{ code: number; err: string }> {
  const child = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text()]);
  return { code, err: err.trim() };
}

async function loaded(dir: AgentDir): Promise<boolean> {
  return (await launchctl(["print", `${domain()}/${serviceLabel(dir)}`])).code === 0;
}

/** Unload if loaded, and wait until launchd agrees it is gone. */
async function bootout(dir: AgentDir): Promise<void> {
  if (!(await loaded(dir))) return;
  await launchctl(["bootout", `${domain()}/${serviceLabel(dir)}`]);
  for (let i = 0; i < 50 && (await loaded(dir)); i++) await Bun.sleep(100);
}

async function bootstrap(plist: string): Promise<string | null> {
  const { code, err } = await launchctl(["bootstrap", domain(), plist]);
  return code === 0 ? null : err || `launchctl bootstrap exited ${code}`;
}
