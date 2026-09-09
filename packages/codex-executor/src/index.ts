import { assistantMessageFromTextOutput, createToolActionRequest, createUnboundActionContext, executeActionInvocation, hasActionOutputMessages, normalizeSchema,
  type CompiledInference, type ExecutorRunRequest, type ExecutorRunResult, type ExecutorRealizePromptRequest, type ProjectorExecutor } from "@projectors/core";
import { json, object, type Projection, type Rpc } from "./protocol.ts";
export type { Rpc } from "./protocol.ts";

/** Projector supplies an IR, not an exact model transcript. Native session policy lives in the host. */
export class CodexExecutor implements ProjectorExecutor {
  readonly identity = { name: "codex" };
  constructor(private readonly rpc: Rpc) {}

  realizePrompt(request: ExecutorRealizePromptRequest) {
    return { provider: "codex", input: { projection: project(request.inference), note: "The host appends changes to a persistent Codex thread; this is the input IR, not its full native transcript." } };
  }

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    if (request.signal?.aborted) return { completionReason: "cancelled" };
    const abort = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal;
    const observed: string[] = [];
    let terminal = false;
    let open = true;
    let toolError: unknown;
    // Keep callbacks serial even if a backend sends multiple calls together.
    let calls = Promise.resolve();
    const current = () => request.refreshInference?.() ?? request.inference;
    const invoke = async (event: Record<string, any>) => {
      if (!open || request.signal?.aborted) return;
      const inference = current();
      let success = false;
      let text: string;
      if (terminal) text = "The activation has ended; no more actions are available.";
      else {
        const action = inference.tools.find((a) => a.name === event.name);
        if (!action || action.executorOwned || !action.run) text = `Action ${String(event.name)} is not available.`;
        else {
          const actionRequest = createToolActionRequest(action.name, event.arguments, event.callId);
          const result = await executeActionInvocation({
            request: actionRequest,
            enqueueRequestBeforeRun: true,
            enqueueMessages(messages) {
              if (!open || request.signal?.aborted) throw new Error("Codex activation is closed");
              request.enqueueFrame({ messages, ...(hasActionOutputMessages(messages, actionRequest) ? {} : { inert: true }) });
              observed.push(...history(messages));
            },
            async run() {
              if (action.inputSchema) normalizeSchema(action.inputSchema).assert(event.arguments);
              return action.run!(event.arguments, request.createActionContext?.(action) ?? createUnboundActionContext());
            },
          });
          success = result.success;
          text = JSON.stringify({ ...(result.success ? { value: result.value ?? null } : { error: result.error }), ...(result.messages?.length ? { messages: result.messages } : {}) });
          terminal ||= result.terminal === true;
        }
      }
      await this.rpc(json({ op: "tool-result", token: event.token, success, text, terminal, projection: project(current()), observed }), undefined, signal);
    };
    try {
      const result: any = await this.rpc(json({ op: "run", generatorId: request.generatorId, activationId: request.activationId,
        ...(object(request.continuationState) && typeof request.continuationState.token === "string" ? { continuation: request.continuationState.token } : {}),
        projection: project(request.inference), ...(request.output?.schema ? { outputSchema: normalizeSchema(request.output.schema).jsonSchema() } : {}) }),
      (event: any) => {
        if (object(event) && event.type === "tool") {
          calls = calls.then(() => invoke(event)).catch((error) => { toolError = error; abort.abort(error); });
          // Surface failures without an unhandled rejection while the host waits.
          void calls.catch(() => {});
        }
      }, signal);
      if (request.signal?.aborted) return { completionReason: "cancelled" };
      await calls;
      if (toolError) throw toolError;
      if (!object(result)) throw new Error("Invalid Codex turn result");
      if (result.status === "continue") return { completionReason: "continue", continuationState: { token: result.continuation } };
      if (request.signal?.aborted || result.status === "interrupted" && !terminal) return { completionReason: "cancelled" };
      if (result.status === "failed") throw new Error(result.error ?? "Codex turn failed");
      const text = typeof result.text === "string" ? result.text : "";
      if (text) {
        const message = assistantMessageFromTextOutput(text, request.output);
        request.enqueueFrame({ messages: [message] });
        observed.push(...history([message]));
      }
      await this.rpc(json({ op: "checkpoint", generatorId: request.generatorId, activationId: request.activationId, projection: project(current()), observed }), undefined, request.signal);
      return { completionReason: terminal ? "terminal-action" : "done", execution: result.execution };
    } catch (error) {
      if (toolError) throw toolError;
      if (request.signal?.aborted) return { completionReason: "cancelled" };
      throw error;
    } finally { open = false; abort.abort(); }
  }
}

function history(messages: CompiledInference["history"]): string[] {
  // Scheduling/horizon bookkeeping is not a new user instruction.
  return messages.filter((m) => !["work", "horizon"].includes(m.type)).map((m) => JSON.stringify(m));
}
function project(inference: CompiledInference): Projection {
  return { preamble: JSON.stringify(inference.preamble), history: history(inference.history), recency: JSON.stringify(inference.recency),
    tools: inference.tools.filter((a) => !a.executorOwned).map((a) => ({ name: a.name, description: a.description ?? "", inputSchema: a.inputSchema ? normalizeSchema(a.inputSchema).jsonSchema() : { type: "object" } })) };
}
