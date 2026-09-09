import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { HostActionError, type JsonValue } from "./action.ts";
import type { HostBrokerOptions } from "./broker.ts";
import type { HostClient } from "./client.ts";
import { object } from "./wire.ts";

const optionsSchema = z.object({
  prompt: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]) }).strict()),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(),
  stopSequences: z.array(z.string()).optional(),
  topP: z.number().finite().optional(), topK: z.number().int().optional(),
  presencePenalty: z.number().finite().optional(), frequencyPenalty: z.number().finite().optional(),
  responseFormat: z.record(z.string(), z.unknown()).optional(), seed: z.number().int().optional(),
  tools: z.array(z.object({ type: z.literal("function"), name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict()).optional(),
  toolChoice: z.record(z.string(), z.unknown()).optional(),
  includeRawChunks: z.literal(false).optional(),
}).strict();

/** The trusted parent selects the provider/model afresh for each request. No URL, header,
 * provider-tool or credential selection is accepted from the worker.
 */
export function createHostModelHandler(getModel: () => LanguageModelV3 | Promise<LanguageModelV3>): NonNullable<HostBrokerOptions["model"]> {
  return async (request, context, emit) => {
    if (!object(request) || !["generate", "stream"].includes(String(request.method)) || Object.keys(request).some((k) => k !== "method" && k !== "options")) throw new HostActionError("invalid model request");
    const parsed = optionsSchema.safeParse(request.options);
    if (!parsed.success) throw new HostActionError("unsupported model options; use text/function tools without headers or provider options");
    // The parent must never download a worker-selected attachment or accept per-message provider options.
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) { for (const child of value) inspect(child); return; }
      if (!object(value)) return;
      if ("providerOptions" in value || "headers" in value) throw new HostActionError("provider options are not granted");
      if (value.type === "file" && (typeof value.data !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(value.data))) throw new HostActionError("model attachments must be inline base64 data");
      for (const child of Object.values(value)) inspect(child);
    };
    inspect(parsed.data.prompt);
    const model = await getModel();
    if (context.signal.aborted) throw new HostActionError("model request cancelled");
    const options = { ...parsed.data, abortSignal: context.signal } as LanguageModelV3CallOptions;
    if (request.method === "generate") {
      const result = await model.doGenerate(options);
      // Request/response bodies and HTTP headers are parent-only diagnostic information.
      const { request: _request, response, ...resultData } = result;
      return json({ ...resultData, ...(response ? { response: { id: response.id, timestamp: response.timestamp, modelId: response.modelId } } : {}) });
    }
    const result = await model.doStream(options);
    const reader = result.stream.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done || context.signal.aborted) break;
        if (next.value.type === "raw") continue;
        emit(json(next.value.type === "error" ? { type: "error", error: "model provider failed" } : next.value));
      }
    } finally {
      context.signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return null;
  };
}

/** AI SDK executes tools in the worker; only provider model calls cross the connection. */
export function createHostLanguageModel(client: HostClient, identity: { provider: string; modelId: string }): LanguageModelV3 {
  const encode = (options: LanguageModelV3CallOptions): JsonValue => {
    const { abortSignal: _, headers, ...data } = options;
    if (headers && Object.keys(headers).some((key) => key.toLowerCase() !== "user-agent")) throw new HostActionError("custom model headers are not granted");
    return json(data);
  };
  return {
    specificationVersion: "v3",
    provider: identity.provider,
    modelId: identity.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const result = await client.model({ method: "generate", options: encode(options) }, undefined, options.abortSignal);
      return restoreTimestamp(result) as LanguageModelV3GenerateResult;
    },
    async doStream(options) {
      const abort = new AbortController();
      const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          void client.model({ method: "stream", options: encode(options) }, (chunk) => {
            if (signal.aborted) return;
            // Bound queued chunks if a consumer stops pulling without cancelling.
            if (Buffer.byteLength(JSON.stringify(chunk)) > (controller.desiredSize ?? 0)) { abort.abort(); return; }
            controller.enqueue(restoreTimestamp(chunk) as LanguageModelV3StreamPart);
          }, signal).then(() => controller.close(), (error) => controller.error(error));
        },
        cancel() { abort.abort(); },
      }, { highWaterMark: 1024 * 1024, size: (chunk) => Buffer.byteLength(JSON.stringify(chunk)) });
      return { stream };
    },
  };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (_key, v) => {
    if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
    if (v instanceof URL) throw new HostActionError("URL attachments are not granted");
    return v;
  })) as JsonValue;
}
function restoreTimestamp(value: unknown): unknown {
  if (!object(value)) return value;
  if (typeof value.timestamp === "string") value.timestamp = new Date(value.timestamp);
  if (object(value.response) && typeof value.response.timestamp === "string") value.response.timestamp = new Date(value.response.timestamp);
  return value;
}
