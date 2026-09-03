import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import type { LanguageModel } from "ai";
import type { ExecutorSpec } from "../agent/define.ts";

/** An activation may run builds and deploys: give it hours, not seconds. */
const TURN_DEADLINE_MS = 2 * 60 * 60 * 1000;
const MAX_STEPS = 40;

export interface AiSdkOptions {
  provider: "anthropic" | "openai";
  model: string;
  /** USD per million tokens, for models the meter does not know. */
  price?: { input: number; output: number };
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * The default executor: projector's AI SDK executor over a provider the
 * AI SDK speaks. Credentials come from the environment (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY), typically via the home's env file.
 */
export function aisdk(opts: AiSdkOptions): ExecutorSpec {
  const node: Record<string, unknown> = {};
  if (opts.maxOutputTokens !== undefined) node.maxOutputTokens = opts.maxOutputTokens;
  if (opts.temperature !== undefined) node.temperature = opts.temperature;
  return {
    model: opts.model,
    price: opts.price,
    executorConfig: Object.keys(node).length ? { aisdk: node } : undefined,
    create: () =>
      new AiSdkExecutor({
        model: languageModelFor(opts),
        maxSteps: MAX_STEPS,
        turnDeadlineMs: TURN_DEADLINE_MS,
        maxOutputTokens: opts.maxOutputTokens ?? 16000,
      }),
  };
}

function languageModelFor(opts: AiSdkOptions): LanguageModel {
  switch (opts.provider) {
    case "openai":
      return openai(opts.model);
    case "anthropic":
      return anthropic(opts.model);
  }
}
