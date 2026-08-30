import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Drift } from "../src/core/types.ts";
import { matchRule } from "../src/playbook/match.ts";
import { loadPlaybook, parseEntry } from "../src/playbook/parse.ts";
import type { PlaybookRule } from "../src/playbook/types.ts";

let tempDir!: string;

beforeEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), "endograph-playbook-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function drift(overrides: Partial<Drift> = {}): Drift {
  return {
    kind: "process.exited",
    subject: "process:api",
    summary: "api exited with code 1",
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function rule(overrides: Partial<PlaybookRule> = {}): PlaybookRule {
  return {
    kind: "rule",
    name: "rule",
    file: "rule.md",
    on: "process.exited",
    provenance: "test",
    cooldownSeconds: 30,
    onFailure: "judge",
    body: "",
    verb: "restart",
    ...overrides,
  };
}

describe("parseEntry", () => {
  test("parses a rule with TOML frontmatter and extracts the first sh fenced block", () => {
    const entry = parseEntry(
      "/playbook/restart-api.md",
      `+++
kind = "rule"
on = "process.*"
subject = "process:api"
match = "ECONNRESET"
provenance = "test"
cooldown_s = 5
+++

Use the reviewed restart path.

\`\`\`sh
endo restart process:api
\`\`\`

\`\`\`sh
echo ignored
\`\`\`
`,
    );

    expect(entry).toMatchObject({
      kind: "rule",
      name: "restart-api",
      file: "/playbook/restart-api.md",
      on: "process.*",
      subject: "process:api",
      provenance: "test",
      cooldownSeconds: 5,
      script: "endo restart process:api",
    });
    expect(entry.kind).toBe("rule");
    if (entry.kind === "rule") {
      expect(entry.match?.test("connection failed\nECONNRESET")).toBe(true);
      expect(entry.body).toContain("Use the reviewed restart path.");
    }
  });

  test("parses a rule with a verb only", () => {
    const entry = parseEntry(
      "stop-worker.md",
      `+++
kind = "rule"
on = "process.exited"
verb = "restart"
+++

Restart the worker through the adapter.
`,
    );

    expect(entry).toMatchObject({
      kind: "rule",
      name: "stop-worker",
      on: "process.exited",
      verb: "restart",
      provenance: "unknown",
      cooldownSeconds: 30,
      onFailure: "judge",
    });
    expect(entry.kind).toBe("rule");
    if (entry.kind === "rule") {
      expect(entry.script).toBeUndefined();
    }
  });

  test("throws when a rule has neither script nor verb", () => {
    expect(() =>
      parseEntry(
        "bad.md",
        `+++
kind = "rule"
on = "process.exited"
+++

No action.
`,
      ),
    ).toThrow(/neither a script block nor a verb/);
  });

  test("maps procedure [[process]] tables to ProcessDef values", () => {
    const entry = parseEntry(
      "/playbook/up.md",
      `+++
kind = "procedure"
provenance = "test"

[[process]]
name = "db"
cmd = "bun run db"
ready = { log = "ready for connections" }

[[process]]
name = "api"
cmd = "bun run api"
cwd = "apps/api"
env = { PORT = "3000" }
after = ["db"]
ready = { http = "http://127.0.0.1:3000/health" }
ready_timeout_s = 12

[[process]]
name = "worker"
cmd = "bun run worker"
after = ["api"]
ready = { port = 4000 }
+++

Bring up local development.
`,
    );

    expect(entry.kind).toBe("procedure");
    if (entry.kind === "procedure") {
      expect(entry).toMatchObject({
        name: "up",
        file: "/playbook/up.md",
        provenance: "test",
        body: "Bring up local development.",
      });
      expect(entry.processes).toEqual([
        {
          name: "db",
          cmd: "bun run db",
          after: [],
          ready: { log: "ready for connections" },
          readyTimeoutSeconds: 60,
        },
        {
          name: "api",
          cmd: "bun run api",
          cwd: "apps/api",
          env: { PORT: "3000" },
          after: ["db"],
          ready: { http: "http://127.0.0.1:3000/health" },
          readyTimeoutSeconds: 12,
        },
        {
          name: "worker",
          cmd: "bun run worker",
          after: ["api"],
          ready: { port: 4000 },
          readyTimeoutSeconds: 60,
        },
      ]);
    }
  });
});

describe("parseEntry procedures", () => {
  test("a script procedure carries its first sh block", () => {
    const entry = parseEntry(
      "/playbook/deploy.md",
      `+++
kind = "procedure"
provenance = "learned"
+++

Deploy the bundle.

\`\`\`sh
scp -r .build/App.app host:/Applications/
\`\`\`
`,
    );
    expect(entry.kind).toBe("procedure");
    if (entry.kind === "procedure") {
      expect(entry.script).toBe("scp -r .build/App.app host:/Applications/");
      expect(entry.processes).toEqual([]);
    }
  });

  test("a procedure needs a script or processes", () => {
    expect(() =>
      parseEntry("empty.md", `+++\nkind = "procedure"\n+++\n\nNothing.\n`),
    ).toThrow(/neither a script block nor \[\[process\]\]/);
  });
});

describe("loadPlaybook", () => {
  test("loads markdown entries in filename order and ignores non-markdown files", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "b.md"), ruleSource("process.exited", "restart"));
    writeFileSync(join(tempDir, "a.md"), ruleSource("process.*", "start"));
    writeFileSync(join(tempDir, "notes.txt"), "ignored");

    const entries = await loadPlaybook(tempDir);

    expect(entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  test("returns an empty list for a missing directory", async () => {
    expect(await loadPlaybook(join(tempDir, "missing"))).toEqual([]);
  });
});

describe("matchRule", () => {
  test("matches kind globs, exact kinds, and returns undefined when no rule matches", () => {
    const globRule = rule({ name: "glob", on: "process.*" });
    const exactRule = rule({ name: "exact", on: "probe.failed" });

    expect(matchRule([globRule], drift({ kind: "process.exited" }))?.name).toBe(
      "glob",
    );
    expect(matchRule([exactRule], drift({ kind: "probe.failed" }))?.name).toBe(
      "exact",
    );
    expect(matchRule([exactRule], drift({ kind: "process.exited" }))).toBeUndefined();
  });

  test("applies subject glob filters", () => {
    const apiRule = rule({ subject: "process:api*" });

    expect(matchRule([apiRule], drift({ subject: "process:api-1" }))).toBe(
      apiRule,
    );
    expect(matchRule([apiRule], drift({ subject: "process:worker" }))).toBeUndefined();
  });

  test("matches regexes against summary plus detail", () => {
    const detailRule = rule({ match: /connection refused on port 3000/m });

    expect(
      matchRule([
        detailRule,
      ], drift({ summary: "api failed", detail: "connection refused on port 3000" })),
    ).toBe(detailRule);
    expect(matchRule([detailRule], drift({ summary: "api failed" }))).toBeUndefined();
  });

  test("uses first match from filename-sorted loadPlaybook order", async () => {
    writeFileSync(join(tempDir, "01-first.md"), ruleSource("process.*", "start"));
    writeFileSync(join(tempDir, "02-second.md"), ruleSource("process.exited", "restart"));

    const entries = await loadPlaybook(tempDir);
    const matched = matchRule(entries, drift({ kind: "process.exited" }));

    expect(matched?.name).toBe("01-first");
    expect(matched?.verb).toBe("start");
  });
});

function ruleSource(on: string, verb: string): string {
  return `+++
kind = "rule"
on = "${on}"
verb = "${verb}"
+++

Use the adapter verb.
`;
}
