import type { JsonValue } from "./action.ts";
export const VERSION = 1;
export const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Reject values JSON would silently drop/coerce, and non-data objects such as Error or Response. */
export function assertJson(value: unknown, seen = new Set<unknown>(), depth = 0): asserts value is JsonValue {
  if (depth > 100) throw new Error("JSON value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || !value || seen.has(value)) throw new Error("value must be JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("value must be plain JSON data");
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertJson(child, seen, depth + 1);
  seen.delete(value);
}
