// Describe mode's process: runs once per load, imports each procedure with
// ENDO_DESCRIBE set, and appends one JSON line per file to the out file (a
// line per file, so a script that hangs before `procedure()` is the one
// after the last line). Stdout is the scripts' own noise and is dropped.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [out, ...files] = process.argv.slice(2);
process.env.ENDO_DESCRIBE = "1";
for (const file of files) {
  let result: { file: string; meta?: unknown; error?: string };
  try {
    await import(pathToFileURL(file).href);
    result = { file, error: "procedure() must be the script's first statement (the script ran to the end without calling it)" };
  } catch (err) {
    result =
      err instanceof Error && err.name === "EndoDescribe" && "meta" in err
        ? { file, meta: (err as { meta: unknown }).meta }
        : { file, error: err instanceof Error ? err.message : String(err) };
  }
  appendFileSync(out!, `${JSON.stringify(result)}\n`);
}
