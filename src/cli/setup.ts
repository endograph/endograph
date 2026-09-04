import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Three ways into an agent directory: it holds a grant; `--template <dir>`
 * copies another directory's two files here; or neither, and endo asks,
 * one question at a time, then writes both files.
 */

export function fromTemplate(dir: string, template: string): string | null {
  const src = resolve(template);
  for (const f of ["endograph.ts", "manifest.md"]) {
    if (!existsSync(join(src, f))) return `${src} has no ${f}`;
    if (existsSync(join(dir, f))) return `${join(dir, f)} already exists; refusing to overwrite`;
  }
  for (const f of ["endograph.ts", "manifest.md"]) copyFileSync(join(src, f), join(dir, f));
  return null;
}

export async function interactiveSetup(dir: string, ask: (question: string, fallback?: string) => Promise<string>): Promise<void> {
  const name = await ask("agent name (kebab-case)", basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""));
  const provider = await ask("executor provider (anthropic | openai)", "anthropic");
  const model = await ask("model", provider === "openai" ? "gpt-5.6-luna" : "claude-opus-5");
  const manifest = await ask("manifest: a path to a markdown file, or enter to write a stub to edit", "");
  const batteries = (await ask("batteries (comma-separated: bash)", "bash")).split(",").map((b) => b.trim()).filter(Boolean);
  const grant = `import { aisdk, ${batteries.map((b) => b).join(", ")}${batteries.length ? ", " : ""}defineAgent } from "endograph";

export default defineAgent({
  name: "${name}",
  manifest: "./manifest.md",
  executor: aisdk({ provider: "${provider}", model: "${model}" }),
  batteries: [${batteries.map((b) => `${b}()`).join(", ")}],
});
`;
  writeFileSync(join(dir, "endograph.ts"), grant);
  if (manifest) copyFileSync(resolve(manifest), join(dir, "manifest.md"));
  else writeFileSync(join(dir, "manifest.md"), `# ${name}\n\nWhat this agent is for, who talks to it, where it runs. Prose; the inceptor reads it.\n`);
}
