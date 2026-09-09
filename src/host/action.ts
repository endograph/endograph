import { normalizeSchema, type AnySchema, type InferSchemaValue } from "@projectors/core";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface HostActionContext {
  /** Bound by the trusted parent when the connection is opened, never supplied by a request. */
  readonly identity: string;
  readonly signal: AbortSignal;
}
export interface HostActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface HostAction<S extends AnySchema = any> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly run: (args: InferSchemaValue<S>, context: HostActionContext) => JsonValue | Promise<JsonValue>;
}

/** A trusted parent's handler. Only its descriptor is sent to the agent process. */
export function hostAction<S extends AnySchema>(definition: HostAction<S>): HostAction<S> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(definition.name)) throw new Error("invalid host action name");
  if (typeof definition.description !== "string" || typeof definition.run !== "function") throw new Error("invalid host action definition");
  normalizeSchema(definition.inputSchema as AnySchema).jsonSchema();
  return Object.freeze({ ...definition });
}

/** An intentionally public error. Ordinary thrown errors are redacted by the broker. */
export class HostActionError extends Error {
  constructor(message: string) { super(message); this.name = "HostActionError"; }
}

export function describeHostActions(actions: readonly HostAction[]): HostActionDescriptor[] {
  const names = new Set<string>();
  return actions.map((a) => {
    if (names.has(a.name)) throw new Error(`duplicate host action ${a.name}`);
    names.add(a.name);
    return { name: a.name, description: a.description, inputSchema: normalizeSchema(a.inputSchema).jsonSchema() };
  });
}
