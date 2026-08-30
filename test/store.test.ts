import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore } from "../src/store/memory.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";
import type { FrameInput, FrameStore } from "../src/store/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "endograph-store-"));
  tempDirs.push(dir);
  return dir;
}

function frame(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    type: "note",
    subject: "subject:one",
    summary: "stored a note",
    incident: "incident-1",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function sharedStoreContract(
  label: string,
  open: () => FrameStore,
): void {
  describe(label, () => {
    test("append assigns monotonic seqs from 1 and lastSeq tracks the log", () => {
      const store = open();
      try {
        expect(store.lastSeq()).toBe(0);

        const first = store.append(frame({ summary: "first" }));
        const second = store.append(frame({ summary: "second" }));
        const third = store.append(frame({ summary: "third" }));

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(third.seq).toBe(3);
        expect(store.lastSeq()).toBe(3);
      } finally {
        store.close();
      }
    });

    test("read(fromSeq, limit) returns ascending frames strictly after fromSeq", () => {
      const store = open();
      try {
        store.append(frame({ summary: "one" }));
        store.append(frame({ summary: "two" }));
        store.append(frame({ summary: "three" }));
        store.append(frame({ summary: "four" }));

        expect(store.read(1, 2).map((f) => f.summary)).toEqual(["two", "three"]);
        expect(store.read(3).map((f) => f.summary)).toEqual(["four"]);
        expect(store.read(4)).toEqual([]);
      } finally {
        store.close();
      }
    });

    test("snapshot write/read roundtrips and overwrites", () => {
      const store = open();
      try {
        expect(store.readSnapshot()).toBeNull();

        store.writeSnapshot({
          asOfSeq: 7,
          at: 1_700_000_000_001,
          state: { processes: { api: "ready" } },
        });
        expect(store.readSnapshot()).toEqual({
          asOfSeq: 7,
          at: 1_700_000_000_001,
          state: { processes: { api: "ready" } },
        });

        store.writeSnapshot({
          asOfSeq: 9,
          at: 1_700_000_000_002,
          state: { processes: { api: "stopped" }, version: 2 },
        });
        expect(store.readSnapshot()).toEqual({
          asOfSeq: 9,
          at: 1_700_000_000_002,
          state: { processes: { api: "stopped" }, version: 2 },
        });
      } finally {
        store.close();
      }
    });

    test("payload JSON roundtrips", () => {
      const store = open();
      try {
        const payload = {
          text: "hello",
          count: 2,
          ok: true,
          nested: { values: [1, "two", null] },
        };

        store.append(frame({ payload }));

        expect(store.read(0)[0]?.payload).toEqual(payload);
      } finally {
        store.close();
      }
    });
  });
}

sharedStoreContract("openMemoryStore", () => openMemoryStore());

sharedStoreContract("openSqliteStore", () =>
  openSqliteStore(join(makeTempDir(), "frames.db")),
);

describe("openSqliteStore persistence", () => {
  test("survives close and reopen with frames and snapshot intact", () => {
    const dbPath = join(makeTempDir(), "frames.db");
    const store = openSqliteStore(dbPath);
    store.append(frame({ summary: "durable one", payload: { n: 1 } }));
    store.append(frame({ summary: "durable two", payload: { n: 2 } }));
    store.writeSnapshot({
      asOfSeq: 2,
      at: 1_700_000_000_003,
      state: { durable: true },
    });
    store.close();

    const reopened = openSqliteStore(dbPath);
    try {
      expect(reopened.lastSeq()).toBe(2);
      expect(reopened.read(0).map((f) => [f.seq, f.summary, f.payload])).toEqual([
        [1, "durable one", { n: 1 }],
        [2, "durable two", { n: 2 }],
      ]);
      expect(reopened.readSnapshot()).toEqual({
        asOfSeq: 2,
        at: 1_700_000_000_003,
        state: { durable: true },
      });
    } finally {
      reopened.close();
    }
  });
});
