import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type {
  PlaybookEntry,
  PlaybookRule,
  Procedure,
  ProcessDef,
  ReadyProbe,
} from "./types.ts";

const FRONTMATTER = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?/;
const FIRST_CODE_BLOCK = /```(?:sh|bash|shell)?\r?\n([\s\S]*?)```/;

const readySchema = z.union([
  z.object({ log: z.string() }),
  z.object({ http: z.string() }),
  z.object({ port: z.number().int() }),
]);

const processSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  after: z.array(z.string()).default([]),
  ready: readySchema.optional(),
  ready_timeout_s: z.number().positive().default(60),
});

const frontmatterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    on: z.string().min(1),
    subject: z.string().optional(),
    match: z.string().optional(),
    verb: z.string().optional(),
    provenance: z.string().default("unknown"),
    cooldown_s: z.number().nonnegative().default(30),
    on_failure: z.enum(["judge", "settle"]).default("judge"),
  }),
  z.object({
    kind: z.literal("procedure"),
    provenance: z.string().default("unknown"),
    process: z.array(processSchema).default([]),
  }),
]);

export function parseEntry(file: string, source: string): PlaybookEntry {
  const fm = source.match(FRONTMATTER);
  if (!fm) {
    throw new Error(`${file}: missing +++ TOML frontmatter`);
  }
  const meta = frontmatterSchema.parse(parseToml(fm[1]!));
  const body = source.slice(fm[0].length).trim();
  const name = basename(file).replace(/\.md$/, "");
  const script = body.match(FIRST_CODE_BLOCK)?.[1]?.trim();

  if (meta.kind === "procedure") {
    const processes: ProcessDef[] = meta.process.map((p) => ({
      name: p.name,
      cmd: p.cmd,
      cwd: p.cwd,
      env: p.env,
      after: p.after,
      ready: p.ready as ReadyProbe | undefined,
      readyTimeoutSeconds: p.ready_timeout_s,
    }));
    if (processes.length === 0 && !script) {
      throw new Error(`${file}: procedure has neither a script block nor [[process]] tables`);
    }
    const proc: Procedure = {
      kind: "procedure",
      name,
      file,
      provenance: meta.provenance,
      processes,
      script,
      body,
    };
    return proc;
  }

  if (!script && !meta.verb) {
    throw new Error(`${file}: rule has neither a script block nor a verb`);
  }
  const rule: PlaybookRule = {
    kind: "rule",
    name,
    file,
    on: meta.on,
    subject: meta.subject,
    match: meta.match ? new RegExp(meta.match, "m") : undefined,
    verb: meta.verb,
    provenance: meta.provenance,
    cooldownSeconds: meta.cooldown_s,
    onFailure: meta.on_failure,
    script,
    body,
  };
  return rule;
}

/** Load every entry in a playbook directory. Non-.md files are ignored. */
export async function loadPlaybook(dir: string): Promise<PlaybookEntry[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const entries: PlaybookEntry[] = [];
  for (const f of files.sort()) {
    const path = join(dir, f);
    entries.push(parseEntry(path, await Bun.file(path).text()));
  }
  return entries;
}
