import { expect, test } from "bun:test";
import { generateText } from "ai";
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createHostBroker } from "../src/host/broker.ts";
import { createHostClient } from "../src/host/client.ts";
import { createHostLanguageModel, createHostModelHandler } from "../src/host/model.ts";
import { ipcPair } from "./fixtures/ipc.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const finishReason = { unified: "stop" as const, raw: "stop" };
function connect(model: LanguageModelV3) {
  const transport = ipcPair();
  const broker = createHostBroker({ identity: "agent:bound", transport: transport.server, actions: () => [], model: createHostModelHandler(() => model) });
  const client = createHostClient({ transport: transport.client });
  return { client, broker, proxy: createHostLanguageModel(client, { provider: "untrusted-label", modelId: "untrusted-label" }), close() { client.close(); broker.close(); } };
}

test("model proxy works with AI SDK; host selects model and strips provider diagnostics", async () => {
  let calls = 0;
  const connection = connect({
    specificationVersion: "v3", provider: "trusted", modelId: "trusted-model", supportedUrls: {},
    async doGenerate(options) {
      calls++;
      expect(options.prompt).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      return { content: [{ type: "text", text: "host answer" }], usage, finishReason, warnings: [], request: { body: "private diagnostic" }, response: { headers: { authorization: "secret" }, timestamp: new Date("2026-01-01T00:00:00Z"), modelId: "trusted-model" } };
    },
    doStream() { throw new Error("unused"); },
  });
  try {
    const result = await generateText({ model: connection.proxy, prompt: "hello" });
    expect(result.text).toBe("host answer");
    expect(result.response.timestamp).toBeInstanceOf(Date);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
    await expect(connection.client.model({ method: "generate", options: { prompt: [], headers: { authorization: "attacker" } } })).rejects.toThrow("unsupported model options");
    await expect(connection.client.model({ method: "generate", options: { prompt: [], tools: [{ type: "provider", id: "web_search" }] } })).rejects.toThrow("unsupported model options");
    await expect(connection.client.model({ method: "generate", options: { prompt: [{ role: "user", content: [{ type: "file", data: "https://internal/secret", mediaType: "image/png" }] }] } })).rejects.toThrow("inline base64");
    expect(calls).toBe(1);
  } finally { connection.close(); }
});

test("model chunks arrive before completion; cancellation reaches the trusted provider", async () => {
  let source!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
  let cancelled = false;
  let hostSignal: AbortSignal | undefined;
  const connection = connect({
    specificationVersion: "v3", provider: "trusted", modelId: "trusted-model", supportedUrls: {},
    doGenerate() { throw new Error("unused"); },
    async doStream(options) {
      hostSignal = options.abortSignal;
      return { stream: new ReadableStream({ start(controller) { source = controller; }, cancel() { cancelled = true; } }) };
    },
  });
  try {
    const { stream } = await connection.proxy.doStream({ prompt: [] });
    const reader = stream.getReader();
    for (let i = 0; i < 50 && !source; i++) await Bun.sleep(2);
    source.enqueue({ type: "text-start", id: "t" });
    source.enqueue({ type: "text-delta", id: "t", delta: "first chunk" });
    expect((await reader.read()).value).toEqual({ type: "text-start", id: "t" });
    expect((await reader.read()).value).toEqual({ type: "text-delta", id: "t", delta: "first chunk" });
    await reader.cancel();
    for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(2);
    expect(cancelled).toBe(true);
    expect(hostSignal?.aborted).toBe(true);
  } finally { connection.close(); }
});
