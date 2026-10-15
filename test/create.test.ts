import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awareness, completedSetupSession, createFromPrefab, loadPrefab, resumeSetup } from "../src/cli/create.ts";
import { loadGrant } from "../src/grant/grant.ts";
import { ensureStateDir, pathsOf } from "../src/harness/paths.ts";
import { incept } from "../src/inception/incept.ts";
import { serviceLabel } from "../src/cli/service.ts";

const dirs: string[] = [];
const prefab = loadPrefab("endodev");
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "endo-create-test-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const generate = async (stage: string) => {
  writeFileSync(join(stage, "manifest.md"), "# Dev helper\n\nManage `bun dev`. No standing testing responsibility.\n");
  writeFileSync(join(stage, "unrequested.ts"), "throw new Error('must never be published')");
};

test("only a published setup supplies conversation context to inception", async () => {
  const repo = directory();
  const agent = join(repo, prefab.directory);
  const thread = "12345678-1234-1234-1234-123456789abc";
  expect(completedSetupSession(agent)).toBeUndefined();
  await expect(createFromPrefab({ repo, prefab, intent: "setup", generate: async (_stage, _prompt, session) => {
    session.save({ harness: "claude", threadId: thread });
    throw new Error("interrupted");
  } })).rejects.toThrow("interrupted");
  expect(completedSetupSession(agent)).toBeUndefined();
  await resumeSetup({ agentDir: agent, generate });
  expect(completedSetupSession(agent)).toEqual({ harness: "claude", threadId: thread });
});

test("creation publishes owner inputs and skills, preserves parent instructions, and refuses an existing instance", async () => {
  const repo = directory();
  const original = "# Project\n\nPreserve this owner's instruction.\n";
  writeFileSync(join(repo, "AGENTS.md"), original);
  const agent = await createFromPrefab({ repo, prefab, intent: "Replace my dev supervisor skill. Keep testing agnostic.", generate });
  expect(readFileSync(join(agent, "manifest.md"), "utf8")).toContain("No standing testing responsibility");
  expect(existsSync(join(agent, "skills/typesafe-ai/SKILL.md"))).toBe(true);
  expect(existsSync(join(agent, "unrequested.ts"))).toBe(false);
  const pkg = JSON.parse(readFileSync(join(agent, "package.json"), "utf8"));
  expect(pkg.dependencies.endograph).toMatch(/^\d+\.\d+\.\d+$/);
  const parent = readFileSync(join(repo, "AGENTS.md"), "utf8");
  expect(parent.startsWith(original)).toBe(true);
  expect(parent).toContain("--agent .endodev");
  expect(awareness(parent, prefab)).toBe(parent);
  const grant = await loadGrant(pathsOf(agent));
  expect(grant.name).toMatch(/^endodev-[a-f0-9]{12}$/);
  expect(grant.executor).toMatchObject({ backend: "codex" });
  expect(grant.sandbox).toBeUndefined();
  expect(grant.cwd).toBe("..");
  await expect(createFromPrefab({ repo, prefab, intent: "Manage development processes", generate })).rejects.toThrow("already exists");
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(parent);
  // A new agent runs on the harness that created it.
  expect((await loadGrant(pathsOf(await createFromPrefab({ repo: directory(), prefab, intent: "setup", harness: "claude", generate })))).executor).toMatchObject({ backend: "claude" });

  // Fresh inception receives the bundled skill without seeding agent procedures.
  ensureStateDir(pathsOf(agent));
  const result = await incept({ agentDir: agent, manual: true });
  expect("manual" in result).toBe(true);
  if ("manual" in result) {
    expect(existsSync(join(result.workspace, "skills/typesafe-ai/SKILL.md"))).toBe(true);
    expect(readFileSync(join(result.workspace, "GRANT.md"), "utf8")).toContain(grant.name);
  }
  expect(readdirSync(join(agent, ".endo/src/procedures"))).toEqual([]);
});

test.each(["generator failure", "invalid config", "host effects", "parent changed"])("%s does not publish a partial agent", async (failure) => {
  const repo = directory();
  writeFileSync(join(repo, "AGENTS.md"), "Owner text\n");
  const marker = join(repo, "effect");
  await expect(createFromPrefab({ repo, prefab, intent: "Manage development processes", generate: async (stage) => {
    if (failure === "generator failure") throw new Error("failed");
    if (failure === "invalid config") writeFileSync(join(stage, "endograph.toml"), "invalid");
    if (failure === "host effects") {
      const file = join(stage, "endograph.toml");
      writeFileSync(file, `host_modules = ["./effect.ts"]\n` + readFileSync(file, "utf8"));
      writeFileSync(join(stage, "effect.ts"), `await Bun.write(${JSON.stringify(marker)}, 'executed');`);
    }
    if (failure === "parent changed") writeFileSync(join(repo, "AGENTS.md"), "Concurrent edit\n");
  } })).rejects.toThrow();
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(repo, ".endodev/endograph.toml"))).toBe(false);
  expect(existsSync(join(repo, ".endodev/.endo/local/setup/draft"))).toBe(true);
  expect(readdirSync(repo).sort()).toEqual([".endodev", "AGENTS.md"]);
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(failure === "parent changed" ? "Concurrent edit\n" : "Owner text\n");
});

test("checked-in owner files work in two Git worktrees with independent identities and ignored state", async () => {
  const root = directory();
  const repo = join(root, "main");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    expect({ code: result.exitCode, errors: result.exitCode ? result.stderr.toString() : "" }).toEqual({ code: 0, errors: "" });
    return result.stdout.toString();
  };
  git("init");
  const agent = await createFromPrefab({ repo, prefab, intent: "Manage development processes", generate });
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "owner inputs");
  const worktree = join(root, "feature");
  git("worktree", "add", "-b", "feature", worktree);
  const a = await loadGrant(pathsOf(agent));
  const b = await loadGrant(pathsOf(join(worktree, ".endodev")));
  expect(a.name).not.toBe(b.name);
  expect(serviceLabel(a.name)).not.toBe(serviceLabel(b.name));
  expect(b.cwd).toBe("..");
  expect(existsSync(join(worktree, ".endodev/.endo"))).toBe(false);
  const alias = join(root, "alias");
  symlinkSync(agent, alias);
  expect((await loadGrant(pathsOf(alias))).name).toBe(a.name);
  ensureStateDir(pathsOf(agent));
  writeFileSync(join(agent, ".env"), "TEST_SECRET=not-a-real-secret\n");
  expect(git("status", "--porcelain")).toBe("");
});


test("later setup keeps the owner's capability changes and refuses agents not made from the prefab", async () => {
  const repo = directory();
  const agent = await createFromPrefab({ repo, prefab, intent: "setup", generate });
  const config = join(agent, "endograph.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace('batteries = ["bash", "scheduler", "evolve"]', 'batteries = ["bash", "scheduler"]'));
  await resumeSetup({ agentDir: agent, intent: "Also watch the logs", generate });
  expect((await loadGrant(pathsOf(agent))).batteries).toEqual(["bash", "scheduler"]);
  await expect(resumeSetup({ agentDir: agent, generate: async (stage) => {
    writeFileSync(join(stage, "endograph.toml"), readFileSync(join(stage, "endograph.toml"), "utf8").replace('["bash", "scheduler"]', '["bash", "scheduler", "evolve"]'));
  } })).rejects.toThrow("identity or capabilities");

  const other = join(repo, ".other");
  mkdirSync(other);
  writeFileSync(join(other, "endograph.toml"), 'name = "other"\n');
  await expect(resumeSetup({ agentDir: other, generate })).rejects.toThrow("was not created from the endodev prefab");
});

test("unfinished drafts resume and later edits keep the thread, dependencies, and agent state", async () => {
  const repo = directory();
  const agent = join(repo, ".endodev");
  const threadId = "12345678-1234-1234-1234-123456789abc";
  await expect(createFromPrefab({ repo, prefab, intent: "setup", generate: async (stage, _prompt, session) => {
    session.save({ harness: "codex", threadId });
    writeFileSync(join(stage, "manifest.md"), "Unfinished mandate");
    throw new Error("cancelled");
  } })).rejects.toThrow("Resume with endo setup");
  await resumeSetup({ agentDir: agent, generate: async (stage, _prompt, session) => {
    expect(session.previous).toEqual({ harness: "codex", threadId });
    expect(readFileSync(join(stage, "manifest.md"), "utf8")).toBe("Unfinished mandate");
    writeFileSync(join(stage, "manifest.md"), "Finished mandate");
  } });
  writeFileSync(join(agent, "package.json"), '{"dependencies":{"endograph":"link:endograph"}}');
  writeFileSync(join(agent, ".endo", "important-state"), "keep");
  writeFileSync(join(agent, "manifest.md"), "Owner's manual revision");
  await resumeSetup({ agentDir: agent, generate: async (stage, _prompt, session) => {
    expect(session.previous).toEqual({ harness: "codex", threadId });
    expect(readFileSync(join(stage, "manifest.md"), "utf8")).toBe("Owner's manual revision");
    writeFileSync(join(stage, "manifest.md"), "Revised mandate");
  } });
  expect(readFileSync(join(agent, "manifest.md"), "utf8")).toBe("Revised mandate");
  expect(readFileSync(join(agent, ".endo/important-state"), "utf8")).toBe("keep");
  expect(readFileSync(join(agent, "package.json"), "utf8")).toContain("link:endograph");
});

test("resume protects concurrent owner edits and accepts a checked-in agent without local setup state", async () => {
  const repo = directory();
  const agent = await createFromPrefab({ repo, prefab, intent: "setup", generate });
  rmSync(join(agent, ".endo/local/setup"), { recursive: true });
  await expect(resumeSetup({ agentDir: agent, generate: async (stage, _prompt, session) => {
    expect(session.previous).toBeUndefined();
    writeFileSync(join(stage, "manifest.md"), "Draft revision");
    writeFileSync(join(agent, "manifest.md"), "Concurrent owner revision");
  } })).rejects.toThrow("changed during setup");
  expect(readFileSync(join(agent, "manifest.md"), "utf8")).toBe("Concurrent owner revision");
});

test("one setup writer per agent, with recoverable drafts after validation failure", async () => {
  const repo = directory();
  const agent = join(repo, ".endodev");
  await expect(createFromPrefab({ repo, prefab, intent: "setup", generate: async (stage) => {
    await expect(resumeSetup({ agentDir: agent, generate: async () => {} })).rejects.toThrow("already open");
    writeFileSync(join(stage, "manifest.md"), "");
  } })).rejects.toThrow("empty manifest");
  await resumeSetup({ agentDir: agent, generate: async (stage) => {
    writeFileSync(join(stage, "manifest.md"), "Recovered mandate");
  } });
  expect(readFileSync(join(agent, "manifest.md"), "utf8")).toBe("Recovered mandate");
});
