import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentDirFromRoot } from "../src/agent/dir.ts";
import { launchAgentPlist, serviceLabel, serviceLogPath } from "../src/cli/service.ts";

describe("launchd service", () => {
  const root = join(tmpdir(), `endograph-service-${process.pid}`);
  const agentRoot = join(root, "app", ".minder");
  mkdirSync(agentRoot, { recursive: true });
  writeFileSync(join(agentRoot, "endograph.toml"), "");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dir = agentDirFromRoot(agentRoot);

  test("label and log derive from project and agent", () => {
    expect(serviceLabel(dir)).toBe("endo.app.minder");
    expect(serviceLogPath(dir)).toBe(join(agentRoot, "minder.log"));
  });

  test("plist runs `endo up` for this agent with the caller's toolchain", () => {
    const plist = launchAgentPlist(dir, {
      bun: "/Users/me/.bun/bin/bun",
      cli: "/Users/me/dev/endograph/src/cli/index.ts",
      path: "/Users/me/.bun/bin:/usr/bin:/bin",
      home: "/Users/me",
    });
    expect(plist).toContain("<string>endo.app.minder</string>");
    expect(plist).toContain(`<string>${agentRoot}</string>\n    <string>up</string>`);
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${join(root, "app")}</string>`);
    expect(plist).toContain("<string>/Users/me/.bun/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain(join(agentRoot, "minder.log"));
  });
});
