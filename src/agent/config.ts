import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * endograph.toml is the GRANT — owner-only, rarely touched. It holds only
 * owner-granted resources: money, schedules, model access, channel
 * credentials, the tool grant. Everything operational is learned and lives
 * in the agent's own src/.
 */

const budgetSchema = z
  .object({
    /** Primary currency is dollars; tokens don't compare across models. */
    daily_usd: z.number().positive().optional(),
    /** Named allocations metered per activation reason. Fractions of daily. */
    envelopes: z
      .object({
        opex: z.number().min(0).max(1).default(0.8),
        capex: z.number().min(0).max(1).default(0.2),
      })
      .default({ opex: 0.8, capex: 0.2 }),
  })
  .default({ envelopes: { opex: 0.8, capex: 0.2 } });

const toolsSchema = z
  .object({
    /**
     * The tool grant notch. v1 implements full-exec (plain bash, the
     * default) and process-verbs is always available regardless.
     */
    grant: z.enum(["full-exec", "scoped-shell", "virtualized"]).default("full-exec"),
  })
  .default({ grant: "full-exec" });

const modelSchema = z
  .object({
    /** Which executor: the Anthropic Messages API or the OpenAI Responses API. */
    provider: z.enum(["anthropic", "openai"]).default("anthropic"),
    model: z.string().default("claude-opus-5"),
    /**
     * USD per million tokens, for metering models the runtime doesn't know.
     * Unknown models without a price are metered at a fallback rate and
     * flagged as estimates.
     */
    price: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
  })
  .default({ provider: "anthropic", model: "claude-opus-5" });

export const configSchema = z.object({
  budget: budgetSchema,
  tools: toolsSchema,
  model: modelSchema,
  schedule: z
    .object({
      /**
       * Lazy capex: after every N opex activations, run a research session
       * (compact if history is long, distill experience into rules). Paced
       * by the workload, never by the clock. 0 = only on `endo capex`.
       */
      capex_every: z.number().int().nonnegative().default(5),
    })
    .default({ capex_every: 5 }),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function parseConfig(source: string): AgentConfig {
  return configSchema.parse(parseToml(source));
}

export async function loadConfig(path: string): Promise<AgentConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return configSchema.parse({});
  return parseConfig(await file.text());
}
