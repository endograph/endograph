import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentConfig } from "../agent/config.ts";

/**
 * The grant names a provider and a model; the AI SDK gives us one
 * LanguageModel interface over both. Credentials come from the environment
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY), typically via the agent's env file.
 */
export function languageModelFor(config: AgentConfig["model"]): LanguageModel {
  switch (config.provider) {
    case "openai":
      return openai(config.model);
    case "anthropic":
      return anthropic(config.model);
  }
}
