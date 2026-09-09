import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { StdioAppServer } from "../src/app-server.ts";

test("missing or exited app-server rejects pending RPCs and closes without hanging", async () => {
  for (const command of ["/nonexistent/endograph-test-codex", process.execPath]) {
    const server = new StdioAppServer({ command, cwd: tmpdir() });
    try { await expect(server.request("thread/start", {})).rejects.toThrow(); }
    finally { await server.close(); }
  }
});
