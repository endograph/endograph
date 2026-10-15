import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../protocol/wire.ts";

/**
 * The coding agents Endograph can open for owner conversations and inception.
 * Codex is preferred unless the owner configures another default; an
 * uninstalled preference falls back to the other harness.
 */

export const HARNESSES = ["codex", "claude"] as const;
export type Harness = (typeof HARNESSES)[number];
export const HARNESS_NAMES: Record<Harness, string> = { codex: "Codex", claude: "Claude Code" };

/** A native conversation, resumable only by the harness that stores it. */
export interface NativeSession {
  harness: Harness;
  threadId: string;
}
export interface NativeConversation {
  previous?: NativeSession;
  save(session: NativeSession): void;
}

/** Headless inceptors: the prompt is appended as the last argument. */
export const HEADLESS: Record<Harness, string> = {
  codex: "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox",
  claude: "claude -p --dangerously-skip-permissions",
};

export const isHarness = (value: unknown): value is Harness => HARNESSES.includes(value as Harness);
const configFile = () => join(process.env.ENDOGRAPH_HOME ?? join(homedir(), ".endograph"), "config.json");

export function configuredHarness(): Harness | undefined {
  if (!existsSync(configFile())) return undefined;
  const harness = (JSON.parse(readFileSync(configFile(), "utf8")) as { harness?: unknown }).harness;
  return isHarness(harness) ? harness : undefined;
}

export function setConfiguredHarness(harness: Harness): void {
  const file = configFile();
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  atomicWrite(dirname(file), basename(file), { ...config, harness });
}

/** The configured default (else Codex), then the other harness. */
export function harnessOrder(): Harness[] {
  const first = configuredHarness() ?? "codex";
  return [first, ...HARNESSES.filter((harness) => harness !== first)];
}

/** An explicit request must be installed; otherwise prefer the stored conversation's harness, then the default order. */
export function chooseHarness(requested?: Harness, previous?: Harness): Harness {
  if (requested) {
    if (!Bun.which(requested)) throw new Error(`${HARNESS_NAMES[requested]} is not installed: install ${requested} and sign in, or choose another --harness.`);
    return requested;
  }
  const found = [...(previous ? [previous] : []), ...harnessOrder()].find((harness) => Bun.which(harness));
  if (!found) throw new Error("No coding agent found: install and sign in to codex or claude.");
  return found;
}
