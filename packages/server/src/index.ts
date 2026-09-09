import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIdentity, isMessage, newId, PROTOCOL_VERSION, readReply, writeMessage } from "endograph/protocol";

export interface ServerOptions {
  /** Owner-selected agent names mapped to their state directories (.endo). */
  agents: Record<string, string>;
  /** Return a verified identity, or null to deny admission. Never copy a body field here. */
  authenticate(request: Request): Promise<string | null> | string | null;
  maxBodyBytes?: number;
}

const scoped = (agent: string, from: string, kind: string, id: string) =>
  createHash("sha256").update(JSON.stringify([agent, from, kind, id])).digest("hex");
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** A per-machine Fetch handler. The embedding owns TLS and authentication providers. */
export function createServer(options: ServerOptions): (request: Request) => Promise<Response> {
  const agents = new Map(Object.entries(options.agents));
  return async (request) => {
    let from: string | null;
    try { from = await options.authenticate(request); } catch { return json({ error: "unauthorized" }, 401); }
    if (!isIdentity(from)) return json({ error: "unauthorized" }, 401);
    const match = /^\/agents\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(messages|replies)(?:\/([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}))?$/.exec(new URL(request.url).pathname);
    if (!match) return json({ error: "not found" }, 404);
    const [, agent, resource, externalId] = match;
    const state = agents.get(agent!);
    if (!state) return json({ error: "not found" }, 404);
    try {
      if (request.method === "GET" && resource === "replies" && externalId) {
        const scopedReply = readReply(join(state, "outbox"), scoped(agent!, from, "id", externalId));
        // Trusted local producers use core IDs directly. Ownership still gates reads.
        const reply = scopedReply?.to === from ? scopedReply : readReply(join(state, "outbox"), externalId);
        if (!reply || reply.to !== from) return json({ error: "not found" }, 404);
        return json({ ...reply, id: externalId });
      }
      if (request.method === "GET" && resource === "messages") {
        const directory = join(state, "outbox", "messages");
        let files: string[];
        try { files = readdirSync(directory); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          files = [];
        }
        const messages = files.filter((file) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}\.json$/.test(file))
          .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")))
          .filter((message) => isMessage(message) && message.kind === "notification" && message.to === from && (!externalId || message.id === externalId));
        if (externalId) return messages[0] ? json(messages[0]) : json({ error: "not found" }, 404);
        // Collection is non-destructive. A pull does not assert external delivery.
        return json({ messages });
      }
      if (request.method !== "POST" || resource !== "messages" || externalId) return json({ error: "not found" }, 404);
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (options.maxBodyBytes ?? 1024 * 1024)) {
          await reader.cancel();
          return json({ error: "message too large" }, 413);
        }
        chunks.push(value);
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid message" }, 400);
      const allowed = ["id", "kind", "text", "procedure", "args", "ref", "origin"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) return json({ error: "unsupported message field" }, 400);
      const id = body.id ?? newId();
      if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)
        || (body.ref !== undefined && typeof body.ref !== "string")) return json({ error: "invalid id or ref" }, 400);
      const message = {
        ...body, kind: body.kind ?? "request", v: PROTOCOL_VERSION,
        id: scoped(agent!, from, "id", id), from, to: `agent:${agent}`, at: Date.now(),
        ...(body.ref !== undefined ? { ref: scoped(agent!, from, "ref", body.ref as string) } : {}),
      };
      if (!isMessage(message) || message.kind === "notification") return json({ error: "invalid message" }, 400);
      writeMessage(join(state, "inbox"), message);
      return json({ id }, 202);
    } catch { return json({ error: "relay unavailable" }, 503); }
  };
}
