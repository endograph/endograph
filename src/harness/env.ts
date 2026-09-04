import { readFileSync } from "node:fs";
import type { Paths } from "./paths.ts";

/**
 * `.endo/env`: KEY=VALUE lines, one per credential the agent's executor
 * and procedures need (OPENAI_API_KEY, deploy keys). Loaded into the
 * process environment when the agent starts, foreground or service, so a
 * unit never holds a secret. Existing environment wins over the file.
 */
export function loadEnv(paths: Paths): string[] {
  let text: string;
  try {
    text = readFileSync(paths.env, "utf8");
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
    keys.push(key);
  }
  return keys;
}
