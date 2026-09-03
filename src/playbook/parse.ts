import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { ArgSpec, PlaybookEntry, Procedure, Rule } from "./types.ts";

const FRONTMATTER = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?/;
const FIRST_CODE_BLOCK = /```(?:sh|bash|shell)?\r?\n([\s\S]*?)```/;

const argSchema = z.object({
  type: z.literal("string").default("string"),
  required: z.boolean().default(false),
  description: z.string().optional(),
});

const frontmatterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    on: z.string().min(1),
    subject: z.string().optional(),
    match: z.string().optional(),
    provenance: z.string().default("unknown"),
    cooldown_s: z.number().nonnegative().default(30),
    on_failure: z.enum(["judge", "settle"]).default("judge"),
  }),
  z.object({
    kind: z.literal("procedure"),
    provenance: z.string().default("unknown"),
    description: z.string().optional(),
    expose: z.boolean().default(false),
    args: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "arg names are UPPER_SNAKE"), argSchema).default({}),
  }),
]);

/** True when a file is a playbook entry rather than a note. */
export function hasFrontmatter(source: string): boolean {
  return FRONTMATTER.test(source);
}

export function parseEntry(file: string, source: string): PlaybookEntry {
  const fm = source.match(FRONTMATTER);
  if (!fm) throw new Error(`${file}: missing +++ TOML frontmatter`);
  const meta = frontmatterSchema.parse(parseToml(fm[1]!));
  const body = source.slice(fm[0].length).trim();
  const name = basename(file).replace(/\.md$/, "");
  const script = body.match(FIRST_CODE_BLOCK)?.[1]?.trim();
  if (!script) throw new Error(`${file}: no script (first \`\`\`sh block) in the body`);

  if (meta.kind === "procedure") {
    const args: Record<string, ArgSpec> = {};
    for (const [key, spec] of Object.entries(meta.args)) {
      args[key] = { required: spec.required, description: spec.description };
    }
    const procedure: Procedure = {
      kind: "procedure",
      name,
      file,
      provenance: meta.provenance,
      description: meta.description,
      expose: meta.expose,
      args,
      script,
      body,
    };
    return procedure;
  }
  const rule: Rule = {
    kind: "rule",
    name,
    file,
    on: meta.on,
    subject: meta.subject,
    match: meta.match ? new RegExp(meta.match, "m") : undefined,
    provenance: meta.provenance,
    cooldownSeconds: meta.cooldown_s,
    onFailure: meta.on_failure,
    script,
    body,
  };
  return rule;
}

/**
 * Load every entry under a src directory, recursively. Files without
 * frontmatter are notes. Two entries with one name is an error: names are
 * ids in the frame log and in `call` messages.
 */
export async function loadPlaybook(srcDir: string): Promise<PlaybookEntry[]> {
  const entries: PlaybookEntry[] = [];
  const seen = new Map<string, string>();
  for (const file of walk(srcDir)) {
    const source = await Bun.file(file).text();
    if (!hasFrontmatter(source)) continue;
    const entry = parseEntry(file, source);
    const other = seen.get(entry.name);
    if (other) throw new Error(`duplicate playbook entry "${entry.name}": ${other} and ${file}`);
    seen.set(entry.name, file);
    entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function walk(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}
