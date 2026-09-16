import { actionResult, createAction, schemaFromJsonSchema, type AnyAction } from "@projectors/core";
import type { HostActionDescriptor, JsonValue } from "./action.ts";
import { DEFAULT_MAX_BYTES, type HostTransport } from "./transport.ts";
import { assertJson, object, validId, VERSION } from "./wire.ts";

export class HostRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "HostRpcError"; }
}
export interface HostClient {
  describe(): Promise<HostActionDescriptor[]>;
  call(name: string, args: JsonValue): Promise<JsonValue>;
  actions(): Promise<AnyAction[]>;
  model(args: JsonValue, onChunk?: (chunk: JsonValue) => void, signal?: AbortSignal): Promise<JsonValue>;
  close(): void;
}
export function createHostClient(opts: { transport: HostTransport; timeoutMs?: number; modelTimeoutMs?: number; maxPending?: number; maxBytes?: number; onShutdown?: () => void }): HostClient {
  const { transport } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; onChunk?: (chunk: JsonValue) => void; cleanup(): void }>();
  const take = (id: string) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    call.cleanup();
    return call;
  };
  let closed = false;
  let unsubscribe = () => {};
  const shutdown = (error = new HostRpcError("disconnected", "host connection closed")) => {
    if (closed) return;
    closed = true;
    for (const id of pending.keys()) take(id)!.reject(error);
    unsubscribe();
    transport.close();
  };
  unsubscribe = transport.subscribe((raw) => {
    if (closed) return;
    try {
      if (Buffer.byteLength(raw) > maxBytes) throw new Error("oversized response");
      const response: unknown = JSON.parse(raw);
      if (object(response) && response.v === VERSION && response.kind === "shutdown" && opts.onShutdown) {
        opts.onShutdown();
        return;
      }
      if (!object(response) || response.v !== VERSION || !validId(response.id) || typeof response.ok !== "boolean") throw new Error("invalid response");
      const call = pending.get(response.id);
      if (!call) return; // A response arriving after cancellation has no recipient.
      if (response.ok && "event" in response) { assertJson(response.event); call.onChunk?.(response.event); return; }
      let error: HostRpcError | undefined;
      if (response.ok) assertJson(response.value);
      else {
        if (!object(response.error) || typeof response.error.code !== "string" || typeof response.error.message !== "string") throw new Error("invalid error response");
        error = new HostRpcError(response.error.code, response.error.message);
      }
      take(response.id);
      if (error) call.reject(error); else call.resolve(response.value as JsonValue);
    } catch { shutdown(new HostRpcError("protocol", "invalid host response")); }
  }, () => shutdown());
  const request = (fields: object, onChunk?: (chunk: JsonValue) => void, signal?: AbortSignal): Promise<JsonValue> => {
    if (signal?.aborted) return Promise.reject(new HostRpcError("cancelled", "host call cancelled"));
    if (closed) return Promise.reject(new HostRpcError("disconnected", "host connection closed"));
    if (pending.size >= (opts.maxPending ?? 32)) return Promise.reject(new HostRpcError("busy", "too many pending host calls"));
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ v: VERSION, id, ...fields });
    if (Buffer.byteLength(raw) > maxBytes) return Promise.reject(new HostRpcError("too_large", "host request too large"));
    return new Promise((resolve, reject) => {
      const cancel = (code: string, message: string) => {
        const call = take(id);
        if (!call) return;
        call.reject(new HostRpcError(code, message));
        try { transport.send(JSON.stringify({ v: VERSION, kind: "cancel", id })); } catch { shutdown(); }
      };
      const abort = () => cancel("cancelled", "host call cancelled");
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => cancel("timeout", "host action timed out"), (fields as { kind?: string }).kind === "model" ? (opts.modelTimeoutMs ?? 2 * 60 * 60 * 1000) : (opts.timeoutMs ?? 30_000));
      pending.set(id, { resolve, reject, timer, onChunk, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { transport.send(raw); } catch { shutdown(); }
    });
  };
  const client: HostClient = {
    async describe() {
      const descriptors = await request({ kind: "describe" });
      if (!Array.isArray(descriptors) || descriptors.some((d) => !object(d) || typeof d.name !== "string" || typeof d.description !== "string" || !object(d.inputSchema))) {
        shutdown(new HostRpcError("protocol", "invalid host descriptors"));
        throw new HostRpcError("protocol", "invalid host descriptors");
      }
      return descriptors as unknown as HostActionDescriptor[];
    },
    async call(name, args) {
      assertJson(args);
      return request({ kind: "call", name, args });
    },
    model: (args, onChunk, signal) => request({ kind: "model", args }, onChunk, signal),
    async actions() {
      return (await client.describe()).map((d) => hostActionProxy(d, client.call));
    },
    close: () => shutdown(),
  };
  return client;
}

/** A normal Projector action containing only a descriptor and an RPC call function. */
export function hostActionProxy(descriptor: HostActionDescriptor, call: (name: string, args: JsonValue) => Promise<JsonValue>): AnyAction {
  return createAction({
    state: null,
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: schemaFromJsonSchema(descriptor.inputSchema),
    run: async (args) => {
      try { return actionResult({ value: await call(descriptor.name, args as JsonValue) }); }
      catch (error) { return actionResult({ success: false, error: error instanceof Error ? error.message : "host call failed" }); }
    },
  });
}
