import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "../src/agent/define.ts";
import { createHome } from "../src/agent/home.ts";
import { openAgent } from "../src/agent/run.ts";
import { bash } from "../src/batteries/bash.ts";
import { inbox } from "../src/batteries/inbox.ts";
import { playbook } from "../src/batteries/playbook.ts";
import { readReply, waitForReply, writeMessage, PROTOCOL_VERSION } from "../src/inbox/protocol.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import { openIncidents } from "../src/store/queries.ts";

/** A whole agent without a model: declaration object, home, batteries, loop. */
function scaffold() {
  process.env.ENDOGRAPH_HOME = mkdtempSync(join(tmpdir(), "endo-reg-"));
  const dir = mkdtempSync(join(tmpdir(), "endo-decl-"));
  writeFileSync(join(dir, "endograph.ts"), "export default {}\n");
  writeFileSync(join(dir, "mandate.md"), "# Mandate\n\ntest\n");
  const definition = defineAgent({ name: "runtest", batteries: [bash(), inbox({ intervalMs: 50 }), playbook()] });
  const home = createHome(join(dir, ".endo", "runtest"), dir);
  writeFileSync(
    join(home.srcDir, "hello.md"),
    `+++\nkind = "procedure"\nexpose = true\n[args.NAME]\nrequired = true\n+++\n\n\`\`\`sh\necho "hi $ENDO_ARG_NAME"\n\`\`\`\n`,
  );
  writeFileSync(join(home.srcDir, "status.md"), `+++\nkind = "rule"\non = "request.received"\nmatch = "status"\n+++\n\n\`\`\`sh\necho quiet\n\`\`\`\n`);
  const loaded = { definition, dir, mandatePath: join(dir, "mandate.md"), cwd: dir };
  return { home, loaded };
}

test("an agent without a model: calls, rules, and honest escalation; open incidents recover on restart", async () => {
  const { home, loaded } = scaffold();
  const agent = await openAgent({ home, loaded });
  agent.start();
  try {
    writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "call", incident: "inc-c", from: "local:t", procedure: "hello", args: { NAME: "x" }, at: 1 });
    writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-r", from: "local:t", text: "status?", at: 2 });
    writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-r2", from: "local:t", text: "and the status again", at: 2 });
    expect((await waitForReply(home.outboxDir, "inc-c", { timeoutMs: 5000, pollMs: 20 }))?.text).toBe("hi x");
    // Both requests arrive in one poll: one drift, the rule matches on their texts, both are settled by it.
    expect((await waitForReply(home.outboxDir, "inc-r", { timeoutMs: 5000, pollMs: 20 }))?.text).toBe("quiet");
    expect((await waitForReply(home.outboxDir, "inc-r2", { timeoutMs: 5000, pollMs: 20 }))?.text).toBe("quiet");
    writeMessage(home.inboxDir, { v: PROTOCOL_VERSION, kind: "request", incident: "inc-j", from: "local:t", text: "deploy", at: 3 });
    expect((await waitForReply(home.outboxDir, "inc-j", { timeoutMs: 5000, pollMs: 20 }))?.state).toBe("failed");
  } finally {
    await agent.stop();
  }

  // Simulate a crash mid-request: a request frame with no reply.
  const store = openSqliteStore(home.dbPath);
  store.append({ type: "request", subject: "request:inc-lost", summary: "local:t: never answered", incident: "inc-lost", at: 4 });
  expect(openIncidents(store).map((f) => f.incident)).toEqual(["inc-lost"]);
  store.close();
  const again = await openAgent({ home, loaded });
  try {
    expect(readReply(home.outboxDir, "inc-lost")?.state).toBe("failed");
    const check = openSqliteStore(home.dbPath);
    expect(openIncidents(check)).toEqual([]);
    check.close();
  } finally {
    await again.stop();
  }
});
