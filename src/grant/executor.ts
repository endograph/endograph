import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import type { ProjectorExecutor } from "@projectors/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";

/** A bound runtime's executor factory and per-node configuration. */
export interface ExecutorSpec {
  create(): ProjectorExecutor;
  /** For the inceptor's GRANT.md: "aisdk openai gpt-5.6-luna". */
  description?: string;
  /** Per-node executor config, namespaced by executor identity ({ aisdk: { maxOutputTokens } }). */
  executorConfig?: Record<string, unknown>;
}

/** An activation may run builds and deploys: give it hours, not seconds. */
const TURN_DEADLINE_MS = 2 * 60 * 60 * 1000;
const MAX_STEPS = 40;

export interface AiSdkOptions {
  provider: "anthropic" | "openai";
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * The default executor: projector's AI SDK executor over a provider the
 * AI SDK speaks. Credentials come from the environment (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY).
 */
export function aisdk(opts: AiSdkOptions, model?: LanguageModelV3): ExecutorSpec {
  const node: Record<string, unknown> = {};
  if (opts.maxOutputTokens !== undefined) node.maxOutputTokens = opts.maxOutputTokens;
  if (opts.temperature !== undefined) node.temperature = opts.temperature;
  return {
    description: `aisdk ${opts.provider} ${opts.model}`,
    executorConfig: Object.keys(node).length ? { aisdk: node } : undefined,
    create: () =>
      new AiSdkExecutor({
        model: model ?? languageModelFor(opts),
        maxSteps: MAX_STEPS,
        turnDeadlineMs: TURN_DEADLINE_MS,
        maxOutputTokens: opts.maxOutputTokens ?? 16000,
      }),
  };
}

export function languageModelFor(opts: AiSdkOptions): LanguageModelV3 {
  switch (opts.provider) {
    case "openai":
      return openai(opts.model);
    case "anthropic":
      return anthropic(opts.model);
  }
}
