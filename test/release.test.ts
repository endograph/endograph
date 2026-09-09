import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion, release } from "../scripts/release.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "endo-release-"));
  dirs.push(root);
  mkdirSync(join(root, "packages/server"), { recursive: true });
  mkdirSync(join(root, "packages/codex-executor"), { recursive: true });
  const files = [join(root, "package.json"), join(root, "packages/server/package.json"), join(root, "packages/codex-executor/package.json")];
  files.forEach((file, i) => writeFileSync(file, JSON.stringify({ name: ["endograph", "@endograph/server", "@endograph/codex-executor"][i], version: "1.2.3",
    ...(i === 1 ? { dependencies: { endograph: "1.2.3" } } : {}),
  })));
  const versions = () => files.map((file) => JSON.parse(readFileSync(file, "utf8")).version);
  return { root, files, versions };
}

test.each([
  ["major", "2.0.0"], ["minor", "1.3.0"], ["patch", "1.2.4"],
] as const)("%s bumps all packages before publishing in dependency order", (bump, expected) => {
  const { root, versions } = fixture();
  const calls: { args: string[]; cwd: string }[] = [];
  release([bump], root, (args, cwd) => {
    expect(versions()).toEqual([expected, expected, expected]);
    const server = JSON.parse(readFileSync(join(root, "packages/server/package.json"), "utf8"));
    expect(server.dependencies.endograph).toBe(expected);
    calls.push({ args, cwd });
  });
  expect(calls).toEqual([
    { args: ["install", "--lockfile-only", "--ignore-scripts"], cwd: root },
    { args: ["publish", "--access", "public", "--tolerate-republish"], cwd: join(root, "packages/codex-executor") },
    { args: ["publish", "--access", "public", "--tolerate-republish"], cwd: root },
    { args: ["publish", "--access", "public", "--tolerate-republish"], cwd: join(root, "packages/server") },
  ]);
});

test("preview leaves manifests untouched and only runs dry publishes", () => {
  const { root, files } = fixture();
  const before = files.map((file) => readFileSync(file, "utf8"));
  const commands: string[][] = [];
  release(["--dry-run"], root, (args) => { commands.push(args); });
  expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  expect(commands).toEqual(Array(3).fill(["publish", "--access", "public", "--dry-run"]));
});

test("a failed first publish stops the release; retry keeps the bumped version", () => {
  const { root, versions } = fixture();
  const published: string[] = [];
  expect(() => release(["patch"], root, (args, cwd) => {
    if (args[0] === "publish") { published.push(cwd); throw new Error("publish failed"); }
  })).toThrow("publish failed");
  expect(published).toEqual([join(root, "packages/codex-executor")]);
  expect(versions()).toEqual(["1.2.4", "1.2.4", "1.2.4"]);
  release([], root, (args) => { expect(args[0]).toBe("publish"); });
  expect(versions()).toEqual(["1.2.4", "1.2.4", "1.2.4"]);
});

test("invalid arguments and mismatched versions fail before any mutation or publish", () => {
  const { root, files, versions } = fixture();
  const unexpected = () => { throw new Error("unexpected command"); };
  expect(() => release(["pacth"], root, unexpected)).toThrow("Usage:");
  expect(() => release(["patch", "--dry-run"], root, unexpected)).toThrow("Usage:");
  expect(versions()).toEqual(["1.2.3", "1.2.3", "1.2.3"]);
  writeFileSync(files[1]!, JSON.stringify({ name: "@endograph/server", version: "1.2.0" }));
  expect(() => release(["patch"], root, unexpected)).toThrow("versions must match");
  expect(versions()).toEqual(["1.2.3", "1.2.0", "1.2.3"]);
  expect(() => bumpVersion("1.2.3-beta.1", "patch")).toThrow("Expected a stable");
});
