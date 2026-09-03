import { actionResult, createAction, executeCommand } from "@projectors/core";
import { asOutcome } from "../judge/activate.ts";
import { z } from "zod";
import type { Battery } from "../agent/define.ts";
import { LateBound, type RuntimeContext } from "../agent/runtime.ts";
import { Inbox } from "../inbox/inbox.ts";
import type { Outcome } from "../loop/types.ts";

/**
 * Message passing: the inbox sensor, the reply tool, and calls to exposed
 * procedures. Without this battery an agent has no peers.
 */
export function inbox(opts: { intervalMs?: number } = {}): Battery {
  const runtime = new LateBound<RuntimeContext>();
  const box = new LateBound<Inbox>();

  const reply = createAction({
    state: null,
    name: "reply",
    description:
      "Answer a peer's request by its incident id. ok=true when the request " +
      "was fulfilled (or needs nothing), false when it was refused, " +
      "superseded, or failed — say why. To ask the sender a question " +
      "instead, set input_required=true. Each request can be answered once; " +
      "any request you leave unanswered is answered with your resolution.",
    inputSchema: z.object({
      to: z.string().describe("The request's incident id, e.g. inc-1a2b3c4d"),
      ok: z.boolean(),
      text: z.string(),
      input_required: z.boolean().optional(),
    }),
    run: ({ to, ok, text, input_required }) =>
      box.get().reply(to, ok, text, input_required ? { state: "input-required" } : {})
        ? `replied to ${to}`
        : actionResult({ success: false, error: `${to} is not awaiting a reply (unknown or already answered)` }),
  });

  const battery: Battery = {
    name: "inbox",
    tools: [reply],
    sensors: [],
    status: () => {
      const pending = box.bound ? box.get().pendingMessages() : [];
      return pending.map((m) => ({
        subject: `request:${m.incident}`,
        state: "yellow" as const,
        summary: m.kind === "call" ? `call ${m.procedure} from ${m.from}, awaiting reply` : `from ${m.from}, awaiting reply: ${m.text.split("\n")[0]}`,
      }));
    },
    bind(ctx) {
      runtime.bind(ctx);
      const instance = new Inbox({
        inboxDir: ctx.home.inboxDir,
        outboxDir: ctx.home.outboxDir,
        record: ctx.record,
        intervalMs: opts.intervalMs,
        onSession: (name, ask) => ctx.session(name, ask).then(asOutcome),
        // A call is a projector command: the exposed procedure's action, run
        // by the machine with the request and result in the log.
        onCall: async (call): Promise<Outcome> => {
          const result = await executeCommand(ctx.world.machine, {
            type: "action",
            kind: "request",
            action: "command",
            name: call.procedure,
            input: call.args,
            callId: call.incident,
          });
          const outcome = result.value as Outcome | undefined;
          if (outcome && typeof outcome === "object" && "ok" in outcome) return outcome;
          if (!result.success) {
            const exposed = ctx.playbook().filter((e) => e.kind === "procedure" && e.expose).map((e) => e.name);
            const unknown = /^Unknown command/.test(result.error);
            return {
              ok: false,
              refused: true,
              summary: unknown
                ? `no exposed procedure "${call.procedure}"${exposed.length ? `; exposed: ${exposed.join(", ")}` : "; none exposed"}`
                : `bad call: ${result.issues ? formatIssues(result.issues) : result.error}`,
            };
          }
          return { ok: true, summary: typeof result.value === "string" ? result.value : "done" };
        },
      });
      box.bind(instance);
      battery.sensors!.push(instance.sensor());
      const recovered = instance.recoverOpen(ctx.store);
      if (recovered) ctx.record({ type: "note", subject: "inbox", summary: `answered ${recovered} incident(s) left open by a restart` });
    },
  };
  return battery;
}

/** Standard Schema issues as one line a peer can act on. */
function formatIssues(issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map((p) => String(typeof p === "object" && p !== null ? p.key : p)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
