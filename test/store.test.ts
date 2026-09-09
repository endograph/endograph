import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePath, openSqliteStore } from "../src/store/sqlite.ts";

test("appends gapless seqs, reads from a seq, and archives frames and instance checkpoints", () => {
  const path = join(mkdtempSync(join(tmpdir(), "endo-")), "agent.db");
  const store = openSqliteStore(path);
  const a = store.append({ type: "note", summary: "one", at: 1 });
  const b = store.append({ type: "note", summary: "two", id: "r1", at: 2, payload: { x: 1 } });
  expect([a.seq, b.seq]).toEqual([1, 2]);
  expect(store.read(1)).toEqual([{ seq: 2, at: 2, type: "note", summary: "two", id: "r1", payload: { x: 1 } }]);
  expect(store.lastSeq()).toBe(2);
  store.writeSnapshot({ asOfSeq: 2, at: 3, state: { s: 1 } });
  store.writeSnapshot({ asOfSeq: 2, at: 4, state: { s: 2 } });
  expect(store.readSnapshot()).toEqual({ asOfSeq: 2, at: 4, state: { s: 2 } });
  // Each completed write is immutable; SQLite remains a rebuildable index.
  expect(readdirSync(archivePath(path)).filter((name) => name.endsWith(".json"))).toHaveLength(4);
  store.close();
});
