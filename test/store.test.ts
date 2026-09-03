import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore } from "../src/store/memory.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import type { FrameStore } from "../src/store/types.ts";

const backends: [string, () => FrameStore][] = [
  ["memory", openMemoryStore],
  ["sqlite", () => openSqliteStore(join(mkdtempSync(join(tmpdir(), "endo-")), "agent.db"))],
];

describe.each(backends)("%s store", (_name, open) => {
  test("appends gapless seqs, reads from a seq, keeps one snapshot", () => {
    const store = open();
    const a = store.append({ type: "note", summary: "one", at: 1 });
    const b = store.append({ type: "note", summary: "two", at: 2, payload: { x: 1 } });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.read(1).map((f) => f.summary)).toEqual(["two"]);
    expect(store.read(1)[0]!.payload).toEqual({ x: 1 });
    expect(store.lastSeq()).toBe(2);
    store.writeSnapshot({ asOfSeq: 2, at: 3, state: { s: 1 } });
    store.writeSnapshot({ asOfSeq: 2, at: 4, state: { s: 2 } });
    expect(store.readSnapshot()).toEqual({ asOfSeq: 2, at: 4, state: { s: 2 } });
    store.close();
  });
});
