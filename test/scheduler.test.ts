import { expect, test } from "bun:test";
import { matches, parseCron } from "../src/batteries/scheduler.ts";

test("cron: fields, ranges, steps, lists, sunday as 7; malformed is null", () => {
  const at = (s: string) => new Date(s);
  expect(matches(parseCron("* * * * *")!, at("2026-09-04T03:07:00"))).toBe(true);
  expect(matches(parseCron("0 3 * * *")!, at("2026-09-04T03:00:00"))).toBe(true);
  expect(matches(parseCron("0 3 * * *")!, at("2026-09-04T03:01:00"))).toBe(false);
  expect(matches(parseCron("*/15 9-17 * * 1-5")!, at("2026-09-04T09:45:00"))).toBe(true);
  expect(matches(parseCron("*/15 9-17 * * 1-5")!, at("2026-09-06T09:45:00"))).toBe(false);
  expect(matches(parseCron("30 22 * * 7")!, at("2026-09-06T22:30:00"))).toBe(true);
  expect(matches(parseCron("0 0 1,15 * *")!, at("2026-09-15T00:00:00"))).toBe(true);
  for (const bad of ["* * * *", "60 * * * *", "a * * * *", "5-1 * * * *", "*/0 * * * *"]) expect(parseCron(bad)).toBeNull();
});
