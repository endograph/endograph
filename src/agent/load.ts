import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAgentDefinition, type AgentDefinition } from "./define.ts";
import { DECLARATION_FILE, isDeclarationDir } from "./home.ts";

export interface LoadedDeclaration {
  definition: AgentDefinition;
  /** Real path of the declaration directory. */
  dir: string;
  mandatePath: string;
  /** Where scripts and bash run. */
  cwd: string;
}

/**
 * Import a declaration through its real path so `endograph.ts` resolves
 * the project's node_modules, and check the default export is an agent.
 */
export async function loadDeclaration(declarationDir: string): Promise<LoadedDeclaration> {
  const dir = realpathSync(declarationDir);
  if (!isDeclarationDir(dir)) throw new Error(`${dir} has no ${DECLARATION_FILE}`);
  const file = join(dir, DECLARATION_FILE);
  const mod = (await import(file)) as { default?: unknown };
  if (!isAgentDefinition(mod.default)) {
    throw new Error(`${file} must \`export default defineAgent({...})\``);
  }
  const definition = mod.default;
  const cwd = resolve(dir, definition.cwd);
  if (!existsSync(cwd)) throw new Error(`cwd ${cwd} (from ${file}) does not exist`);
  return { definition, dir, mandatePath: resolve(dir, definition.mandate), cwd };
}

export async function readMandate(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}
