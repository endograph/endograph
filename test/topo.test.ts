import { describe, expect, test } from "bun:test";
import { topoSort } from "../src/adapters/dev/adapter.ts";
import type { ProcessDef } from "../src/playbook/types.ts";

function proc(name: string, after: string[] = []): ProcessDef {
  return {
    name,
    cmd: `run ${name}`,
    after,
    readyTimeoutSeconds: 60,
  };
}

describe("topoSort", () => {
  test("orders after-dependencies before dependents", () => {
    expect(topoSort([proc("web", ["api"]), proc("db"), proc("api", ["db"])])).toEqual([
      "db",
      "api",
      "web",
    ]);
  });

  test("throws on cycles", () => {
    expect(() => topoSort([proc("a", ["b"]), proc("b", ["a"])])).toThrow(
      /cycle/,
    );
  });

  test("throws on unknown dependencies", () => {
    expect(() => topoSort([proc("api", ["db"])])).toThrow(
      /unknown dependency "db"/,
    );
  });
});
