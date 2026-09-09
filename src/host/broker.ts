import { describeHostActions, HostActionError, type HostAction, type HostActionContext, type JsonValue } from "./action.ts";
import { DEFAULT_MAX_BYTES, type HostTransport } from "./transport.ts";
import { assertJson, object, validId, VERSION } from "./wire.ts";

export interface HostBrokerOptions {
  identity: string;
  transport: HostTransport;
  /** Validation connections may inspect schemas but cannot execute host actions or models. */
  describeOnly?: boolean;
  /** Called for every invocation; revocation applies even to previously obtained proxies. */
  actions: () => readonly HostAction[] | Promise<readonly HostAction[]>;
  /** The parent selects the model; requests carry model inputs only. */
  model?: (args: JsonValue, context: HostActionContext, emit: (chunk: JsonValue) => void) => Promise<JsonValue>;
  timeoutMs?: number;
  modelTimeoutMs?: number;
  maxInFlight?: number;
  maxBytes?: number;
}

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
const failure = (code: string, message: string): Result => ({ ok: false, error: { code, message } });

/** Dispatch computes a result; the connection owns cancellation and replying exactly once. */
async function dispatch(opts: HostBrokerOptions, request: Record<string, unknown>, context: HostActionContext, emit: (chunk: JsonValue) => void): Promise<Result> {
  if (opts.describeOnly && request.kind !== "describe")
    return failure("denied", "host execution is unavailable during validation");
  if (request.kind === "model") {
    if (!opts.model) return failure("denied", "model access is not granted");
    assertJson(request.args);
    return { ok: true, value: await opts.model(request.args, context, emit) };
  }
  const actions = await opts.actions();
  context.signal.throwIfAborted();
  const registry = new Map(actions.map((action) => [action.name, action]));
  if (registry.size !== actions.length) throw new Error("duplicate action registration");
  if (request.kind === "describe") return { ok: true, value: describeHostActions(actions) };
  if (typeof request.name !== "string" || !("args" in request)) return failure("bad_request", "host call needs name and args");
  const action = registry.get(request.name);
  if (!action) return failure("denied", "host action is not granted");
  const validation = await action.inputSchema["~standard"].validate(request.args);
  context.signal.throwIfAborted();
  if (validation.issues) return failure("invalid_args", "host action arguments failed validation");
  return { ok: true, value: await action.run(validation.value, context) };
}

export function createHostBroker(opts: HostBrokerOptions): { close(): void } {
  const { transport } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const inFlight = new Map<string, { abort: AbortController; answered: boolean; timer: ReturnType<typeof setTimeout> }>();
  const recent = new Set<string>();
  let closed = false;
  let unsubscribe = () => {};
  const shutdown = () => {
    if (closed) return;
    closed = true;
    for (const call of inFlight.values()) { clearTimeout(call.timer); call.abort.abort(); }
    unsubscribe();
    transport.close();
  };
  const respond = (id: string, body: object) => {
    if (closed) return;
    let message = JSON.stringify({ v: VERSION, id, ...body });
    if (Buffer.byteLength(message) > maxBytes) message = JSON.stringify({ v: VERSION, id, ok: false, error: { code: "too_large", message: "host result too large" } });
    try { transport.send(message); } catch { shutdown(); }
  };
  const reject = (id: string, code: string, message: string) => respond(id, failure(code, message));
  const receive = (raw: string) => {
    if (closed) return;
    if (Buffer.byteLength(raw) > maxBytes) return shutdown();
    let request: unknown;
    try { request = JSON.parse(raw); } catch { return shutdown(); }
    if (!object(request) || !validId(request.id)) return shutdown();
    const { id } = request;
    const allowed = request.kind === "call" ? ["v", "id", "kind", "name", "args"] : request.kind === "model" ? ["v", "id", "kind", "args"] : ["v", "id", "kind"];
    if (request.v !== VERSION || Object.keys(request).some((key) => !allowed.includes(key)) || !["call", "describe", "cancel", "model"].includes(String(request.kind)))
      return reject(id, "bad_request", "malformed host request");
    if (request.kind === "cancel") {
      const call = inFlight.get(id);
      if (call) { call.answered = true; clearTimeout(call.timer); call.abort.abort(); }
      return;
    }
    if (recent.has(id)) return reject(id, "duplicate", "duplicate host request id");
    recent.add(id);
    if (recent.size > 4096) recent.delete(recent.values().next().value!);
    if (inFlight.size >= (opts.maxInFlight ?? 32)) return reject(id, "busy", "too many host requests");
    const abort = new AbortController();
    const call = {
      abort,
      answered: false,
      timer: setTimeout(() => {
        finish(failure("timeout", "host action timed out"));
        abort.abort();
      }, request.kind === "model" ? (opts.modelTimeoutMs ?? 2 * 60 * 60 * 1000) : (opts.timeoutMs ?? 30_000)),
    };
    const finish = (result: Result) => {
      if (closed || call.answered) return;
      call.answered = true;
      clearTimeout(call.timer);
      respond(id, result);
    };
    inFlight.set(id, call);
    void (async () => {
      try {
        const result = await dispatch(opts, request, { identity: opts.identity, signal: abort.signal }, (event) => {
          if (closed || call.answered) return;
          assertJson(event);
          if (Buffer.byteLength(JSON.stringify({ v: VERSION, id, ok: true, event })) > maxBytes) throw new HostActionError("model chunk too large");
          respond(id, { ok: true, event });
        });
        if (closed || call.answered) return;
        if (result.ok) assertJson(result.value);
        finish(result);
      } catch (error) {
        finish(failure("handler_error", error instanceof HostActionError ? error.message.slice(0, 2048) : "host action failed"));
      } finally {
        // Cancellation ends the reply, not necessarily the handler. Retain
        // capacity until it settles, even if it ignores its abort signal.
        clearTimeout(call.timer);
        inFlight.delete(id);
      }
    })();
  };
  unsubscribe = transport.subscribe(receive, shutdown);
  return { close: shutdown };
}
