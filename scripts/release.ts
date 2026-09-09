import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Bump = "major" | "minor" | "patch";
type Run = (args: string[], cwd: string) => void;
const usage = "Usage: bun run release [major|minor|patch] or bun run release:check";

export function bumpVersion(version: string, bump: Bump): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable major.minor.patch version, got ${version}`);
  }
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function runBun(args: string[], cwd: string): void {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`bun ${args.join(" ")} failed (exit ${result.exitCode})`);
}

export function release(args: string[], root: string, run: Run = runBun): void {
  const option = args[0];
  if (args.length > 1 || (option !== undefined && !["major", "minor", "patch", "--dry-run"].includes(option))) {
    throw new Error(usage);
  }
  const dryRun = option === "--dry-run";
  const packages = [join(root, "packages/codex-executor"), root, join(root, "packages/server")].map((cwd) => {
    const file = join(cwd, "package.json");
    return { cwd, file, manifest: JSON.parse(readFileSync(file, "utf8")) };
  });
  const version: string = packages[0]!.manifest.version;
  for (const pkg of packages) {
    if (pkg.manifest.version !== version) throw new Error("Release versions must match in all package.json files.");
    if (pkg.manifest.private) throw new Error(`${pkg.manifest.name} is marked private.`);
  }
  if (option && !dryRun) {
    const next = bumpVersion(version, option as Bump);
    const names = new Set(packages.map((pkg) => pkg.manifest.name));
    for (const pkg of packages) {
      pkg.manifest.version = next;
      // The repository root cannot be referenced with Bun's workspace protocol.
      // Keep explicit runtime dependencies on sibling release packages in step.
      for (const [name, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
        if (names.has(name) && !String(range).startsWith("workspace:")) pkg.manifest.dependencies[name] = next;
      }
      writeFileSync(pkg.file, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
    }
    console.log(`Release version: ${version} → ${next}`);
    // Keep workspace metadata current without running dependency lifecycle scripts.
    run(["install", "--lockfile-only", "--ignore-scripts"], root);
  }
  // A failed publish keeps the version bump. Retry without a bump argument;
  // tolerate-republish lets a completed first package be skipped on that retry.
  for (const pkg of packages) {
    console.log(`${dryRun ? "Checking" : "Publishing"} ${pkg.manifest.name}@${pkg.manifest.version}`);
    run(["publish", "--access", "public", dryRun ? "--dry-run" : "--tolerate-republish"], pkg.cwd);
  }
}

if (import.meta.main) {
  try {
    release(process.argv.slice(2), resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
