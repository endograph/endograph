import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "../src/store/sqlite.ts";

test("appends gapless seqs, reads from a seq, keeps one snapshot, and checkpoints at the snapshot", () => {
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
  // The WAL is folded into agent.db at every snapshot: a copy of that one file is the whole log.
  expect(statSync(`${path}-wal`).size).toBe(0);
  store.close();
});
