import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursor, digest, withoutStanding, type Cursor } from "./context.ts";
import type { Projection } from "./protocol.ts";

/** A generator's native conversation, as the trusted host persists it between activations. */
export interface SessionRecord {
  version: 1;
  cursor?: Cursor;
  /** The activation whose native turn may have run without being recorded. */
  pending?: string;
  activationId?: string;
  model?: string;
  /** The native conversation was compacted and its standing context could not be restored in that turn. */
  compacted?: boolean;
}

/** Atomic per-generator session files. A session is resumable only once its activation is durably committed. */
export class SessionFiles<S extends SessionRecord> {
  constructor(private options: { stateDir: string; model?: string; isActivationCommitted(activationId: string): boolean }, private id: keyof S & string) {}
  save(generator: string, session: S) {
    const { stateDir } = this.options;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, `${digest(generator)}.json`);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(session), { mode: 0o600 });
      const fd = openSync(temp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(stateDir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { rmSync(temp, { force: true }); }
  }
  read(generator: string): S | undefined {
    try {
      const value = JSON.parse(readFileSync(join(this.options.stateDir, `${digest(generator)}.json`), "utf8"));
      if (value.version === 1 && typeof value[this.id] === "string" && !value.pending && typeof value.activationId === "string"
        && value.model === this.options.model && this.options.isActivationCommitted(value.activationId)) return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** The worker recorded the activation: remember what the native conversation has been given. */
export function checkpoint(session: SessionRecord, input: { activationId: string; projection: Projection; observed: string[] }) {
  session.cursor = cursor(input.projection, input.observed);
  if (session.compacted) { session.cursor = withoutStanding(session.cursor); delete session.compacted; }
  session.activationId = input.activationId;
  delete session.pending;
}
