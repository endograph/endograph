import { createToolActionRequest, executeActionInvocation, type ExecuteActionResult, type ExecutorRunRequest, type ProjectorExecutor } from "@projectors/core";
import type { ExecutorSpec } from "endograph";

/** An executor that runs a script per activation instead of a model: the fixtures' stand-in for the model. */

export interface Turn {
  requests: { id: string; from: string; text: string }[];
  call(name: string, input: unknown): Promise<ExecuteActionResult>;
  signal?: AbortSignal;
}

export function scripted(script: (turn: Turn) => Promise<void>): ProjectorExecutor {
  return {
    identity: { name: "scripted" },
    realizePrompt: () => ({ provider: "scripted", input: null }),
    async run(request: ExecutorRunRequest) {
      const requests: Turn["requests"] = [];
      for (let i = request.inference.history.length - 1; i >= 0; i--) {
        const m = request.inference.history[i]!;
        if (m.type === "work") continue;
        if (m.type !== "user" || typeof m.text !== "string") break;
        const header = m.text.match(/^\[request id=(\S+) from=(\S+)[^\]]*\]\n([\s\S]*)$/);
        if (header) requests.unshift({ id: header[1]!, from: header[2]!, text: header[3]! });
      }
      const call: Turn["call"] = async (name, input) => {
        const action = request.inference.tools.find((t) => t.name === name);
        if (!action) throw new Error(`no tool ${name}; have ${request.inference.tools.map((t) => t.name).join(", ")}`);
        const req = createToolActionRequest(name, input, crypto.randomUUID().slice(0, 8));
        return executeActionInvocation({
          request: req,
          run: () => action.run!(input, request.createActionContext!(action)),
          enqueueMessages: (messages) => void request.enqueueFrame({ messages }),
        });
      };
      await script({ requests, call, signal: request.signal });
      return { completionReason: "done" };
    },
  };
}

/** The fixtures' one script: answer arithmetic, run hello, note things, ignore or hang on request. */
export const answer = async (turn: Turn) => {
  for (const r of turn.requests) {
    if (r.text.includes("ignore")) continue;
    if (r.text.includes("hang")) {
      await new Promise<void>((done) => turn.signal?.addEventListener("abort", () => done()));
      continue;
    }
    if (r.text.includes("hello")) {
      const result = await turn.call("hello", { NAME: "bob" });
      await turn.call("reply", { id: r.id, ok: result.success, text: String(result.success ? result.value : result.error) });
      continue;
    }
    if (r.text.includes("note")) await turn.call("update_state", { state: "notes", op: "append", values: [r.text] });
    if (r.text.includes("spawn")) {
      const spawned = await turn.call("spawn", { node: { key: "helper", purpose: "test", instructions: "Help.", tools: ["bash", "nope"] }, reason: "asked" });
      if (!spawned.success) await turn.call("spawn", { node: { key: "helper", purpose: "test", instructions: "Help.", tools: ["bash"] }, reason: "asked" });
      await turn.call("reply", { id: r.id, ok: true, text: spawned.success ? "spawned first try" : String(spawned.error) });
      continue;
    }
    await turn.call("reply", { id: r.id, ok: true, text: r.text.includes("2+2") ? "4" : `seen from ${r.from}` });
  }
};

const scriptedSpec: ExecutorSpec = { description: "scripted (test)", create: () => scripted(answer) };
export default scriptedSpec;
