import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `endo up -d`: run the agent under the platform supervisor. A launchd user
 * agent on macOS (now and at every login), a systemd user unit on Linux
 * (lingering enabled so it survives logout). Units run `endo up --service`
 * in the agent directory. Both restart a failure and leave a clean exit
 * alone, so a service that exits 0 (a program that no longer loads) does
 * not crash-loop.
 */

export function serviceLabel(name: string): string {
  return `endograph.${name}`;
}

function cliPath(): string {
  return fileURLToPath(new URL("./index.ts", import.meta.url));
}

function plistPath(name: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${serviceLabel(name)}.plist`);
}

function unitPath(name: string): string {
  return join(homedir(), ".config", "systemd", "user", `${serviceLabel(name)}.service`);
}

export interface ServiceInfo {
  file: string;
  installed: boolean;
}

export function serviceInfo(name: string): ServiceInfo {
  const file = platform() === "darwin" ? plistPath(name) : unitPath(name);
  return { file, installed: existsSync(file) };
}

export async function installService(name: string, agentDir: string): Promise<void> {
  const bun = process.execPath;
  const log = join(agentDir, ".endo", "endo.log");
  mkdirSync(join(agentDir, ".endo"), { recursive: true });
  if (platform() === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(serviceLabel(name))}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(bun)}</string><string>${esc(cliPath())}</string><string>up</string><string>--service</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(agentDir)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await Bun.write(plistPath(name), plist);
    await launchctl(["bootout", `${domain()}/${serviceLabel(name)}`]);
    // bootout returns before the job is gone; bootstrapping the same label
    // meanwhile fails with "Input/output error". Wait for the unload, then retry.
    for (let i = 0; i < 50 && (await launchctl(["print", `${domain()}/${serviceLabel(name)}`])) === null; i++) await Bun.sleep(200);
    let err: string | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      err = await launchctl(["bootstrap", domain(), plistPath(name)]);
      if (!err) return;
      await Bun.sleep(500);
    }
    throw new Error(`launchctl bootstrap failed: ${err}`);
  }
  const unit = `[Unit]
Description=endograph agent ${name}

[Service]
ExecStart=${bun} ${cliPath()} up --service
WorkingDirectory=${agentDir}
Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}
Restart=on-failure
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  await Bun.write(unitPath(name), unit);
  await run(["loginctl", "enable-linger"]);
  await run(["systemctl", "--user", "daemon-reload"]);
  const err = await run(["systemctl", "--user", "enable", "--now", `${serviceLabel(name)}.service`]);
  if (err) throw new Error(`systemctl enable failed: ${err}`);
  await run(["systemctl", "--user", "restart", `${serviceLabel(name)}.service`]);
}

export async function removeService(name: string): Promise<boolean> {
  const info = serviceInfo(name);
  if (platform() === "darwin") {
    await launchctl(["bootout", `${domain()}/${serviceLabel(name)}`]);
  } else {
    await run(["systemctl", "--user", "disable", "--now", `${serviceLabel(name)}.service`]);
  }
  if (info.installed) unlinkSync(info.file);
  return info.installed;
}

export async function serviceRunning(name: string): Promise<boolean> {
  if (platform() === "darwin") return (await launchctl(["print", `${domain()}/${serviceLabel(name)}`])) === null;
  return (await run(["systemctl", "--user", "is-active", "--quiet", `${serviceLabel(name)}.service`])) === null;
}

/** What the supervisor knows about the unit: enough to tell a crash loop from a clean exit from nothing installed. */
export interface ServiceState {
  /** The unit file exists. */
  installed: boolean;
  /** The supervisor has the unit loaded (it would restart a crash). */
  loaded: boolean;
  /** The process is alive now. */
  pid: number | null;
  /** The last exit status; null when it has not exited (launchd) or is unknown. */
  lastExit: number | null;
  /** How many times the supervisor has started it (launchd: runs; systemd: restarts). */
  runs: number | null;
}

export async function serviceState(name: string): Promise<ServiceState> {
  const state: ServiceState = { installed: serviceInfo(name).installed, loaded: false, pid: null, lastExit: null, runs: null };
  const num = (m: RegExpExecArray | null) => (m ? Number(m[1]) : null);
  if (platform() === "darwin") {
    const out = await output(["launchctl", "print", `${domain()}/${serviceLabel(name)}`]);
    if (out === null) return state;
    state.loaded = true;
    state.pid = num(/^\s*pid = (\d+)/m.exec(out));
    state.lastExit = num(/^\s*last exit code = (-?\d+)/m.exec(out));
    state.runs = num(/^\s*runs = (\d+)/m.exec(out));
  } else {
    const out = await output(["systemctl", "--user", "show", "-p", "LoadState,MainPID,ExecMainStatus,NRestarts", `${serviceLabel(name)}.service`]);
    if (out === null || /^LoadState=not-found/m.test(out)) return state;
    state.loaded = true;
    state.pid = num(/^MainPID=(\d+)/m.exec(out)) || null;
    state.lastExit = num(/^ExecMainStatus=(\d+)/m.exec(out));
    state.runs = num(/^NRestarts=(\d+)/m.exec(out));
  }
  return state;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function launchctl(args: string[]): Promise<string | null> {
  return run(["launchctl", ...args]);
}

/** Stdout on success, null on failure. */
async function output(cmd: string[]): Promise<string | null> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text()]);
  return code === 0 ? out : null;
}

/** Null on success, stderr on failure. */
async function run(cmd: string[]): Promise<string | null> {
  const child = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text()]);
  return code === 0 ? null : err.trim() || `exit ${code}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
