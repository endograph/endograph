import * as p from "@clack/prompts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class PromptCancelled extends Error {
  constructor() { super("Setup cancelled."); }
}
function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled. You can return whenever you’re ready.");
    throw new PromptCancelled();
  }
  return value as Exclude<T, symbol>;
}
const expand = (value: string) => resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);

/** Why a repository answer is refused, if it is: not a directory, or it already holds an agent to resume. */
export function repositoryProblem(agentDirectory: string, value: string | undefined, fallback = process.cwd()): string | undefined {
  const directory = expand(value || fallback);
  try {
    if (!statSync(directory).isDirectory()) return "Choose a directory, not a file.";
    if (existsSync(join(directory, agentDirectory)))
      return `Already has ${agentDirectory}. Resume with: endo setup --agent ${JSON.stringify(join(directory, agentDirectory))}`;
  } catch { return "Directory not found. Check the path and try again."; }
}

export async function repositoryPrompt(agentDirectory: string): Promise<string> {
  const fallback = process.cwd();
  const value = answer(await p.text({
    message: `Which directory should ${agentDirectory.replace(/^\./, "")} work in?`,
    placeholder: fallback, defaultValue: fallback,
    validate: (value) => repositoryProblem(agentDirectory, value, fallback),
  }));
  return realpathSync(expand(value || fallback));
}

export async function intentPrompt(): Promise<string> {
  return answer(await p.text({
    message: "What would you like it to take over? (optional)",
    placeholder: "e.g. Replace my dev supervisor skill",
    defaultValue: "",
  })).trim();
}

export async function askText(message: string, fallback = ""): Promise<string> {
  return answer(await p.text({ message, placeholder: fallback, defaultValue: fallback })).trim() || fallback;
}

export async function startPrompt(): Promise<boolean> {
  return answer(await p.confirm({
    message: "Ready to incept and start the agent?", initialValue: false,
    active: "Incept and start", inactive: "Review first",
  }));
}

export { intro, outro, log, note } from "@clack/prompts";
