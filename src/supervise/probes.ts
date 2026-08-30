import type { ReadyProbe } from "../playbook/types.ts";

/** True if a TCP connection to localhost:port succeeds. */
export async function probePort(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const socket = await Promise.race([
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, error() {} },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** True if the URL answers with any status < 500 (a 404 still means "up"). */
export async function probeHttp(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Check a probe once. Log probes are answered from the process's own output
 * (the caller passes a matcher over lines seen so far).
 */
export async function checkProbe(
  probe: ReadyProbe,
  logSeen: (re: RegExp) => boolean,
): Promise<boolean> {
  if ("port" in probe) return probePort(probe.port);
  if ("http" in probe) return probeHttp(probe.http);
  return logSeen(new RegExp(probe.log));
}
