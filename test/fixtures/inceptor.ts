// The fixture inceptor: what a coding agent would do, minus the thinking.
// Run in the agent directory with the prompt as its argument.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.cwd();
const workspace = join(dir, ".endo/workspace");
for (const f of ["TASK.md", "MANIFEST.md", "GRANT.md", "PROGRAM.md", "batteries/bash.md"]) {
  if (!existsSync(join(workspace, f))) throw new Error(`workspace is missing ${f}`);
}
if (!readFileSync(join(workspace, "GRANT.md"), "utf8").includes("### reply")) throw new Error("GRANT.md does not list reply");
if (!process.argv[2]?.includes("TASK.md")) throw new Error(`unexpected prompt: ${process.argv[2]}`);

// Round 1 writes a program with a bad header; round 2 (ERRORS.md present) fixes it. Both seed src.
const fixtures = process.env.ENDO_FIXTURES!;
let program = readFileSync(join(fixtures, "program.ts"), "utf8");
if (!existsSync(join(workspace, "ERRORS.md"))) program = program.replace("Do not edit:", "do not edit");
mkdirSync(join(dir, ".endo/program"), { recursive: true });
writeFileSync(join(dir, ".endo/program/agent.ts"), program);
mkdirSync(join(dir, ".endo/src/procedures"), { recursive: true });
writeFileSync(join(dir, ".endo/src/procedures/hello.ts"), readFileSync(join(fixtures, "procedures/hello.ts"), "utf8"));
writeFileSync(join(dir, ".endo/src/README.md"), "# fixture\n\nSeeded by the fixture inceptor.\n");
if (existsSync(join(workspace, "BASELINE"))) {
  if (!readFileSync(join(workspace, "EVOLUTION.md"), "utf8").startsWith("# EVOLUTION")) throw new Error("no EVOLUTION.md for a revision");
  writeFileSync(join(workspace, "CHANGES.md"), "Your manifest now asks you to be brief. Nothing else moved.\n");
}
console.log("fixture inceptor wrote the program");
