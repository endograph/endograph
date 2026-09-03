import { createAction } from "@projectors/core";
import { z } from "zod";
import type { Battery } from "../agent/define.ts";
import { LateBound, type RuntimeContext } from "../agent/runtime.ts";
import { runShell } from "../playbook/run.ts";

/**
 * Plain bash under the agent's working directory: the agent can do what
 * its user can. Sandbox notches (loopback only, allowlisted hosts,
 * offline) arrive here as options; the model's API call never runs
 * inside them.
 */
export function bash(): Battery {
  const runtime = new LateBound<RuntimeContext>();
  const tool = createAction({
    state: null,
    name: "bash",
    description:
      "Run a shell command in the working directory. Use for diagnosis " +
      "(read files, check hosts/ports/processes) and for repairs. Long " +
      "operations (builds, deploys) are fine: set timeout_s.",
    inputSchema: z.object({ cmd: z.string(), timeout_s: z.number().positive().max(3600).optional() }),
    run: async ({ cmd, timeout_s }) => {
      const result = await runShell(cmd, runtime.get().scripts, { timeoutMs: (timeout_s ?? 120) * 1000, tailLines: 80 });
      return `exit ${result.code}\n${result.detail ?? ""}`.trimEnd();
    },
  });
  return { name: "bash", tools: [tool], bind: (ctx) => runtime.bind(ctx) };
}
