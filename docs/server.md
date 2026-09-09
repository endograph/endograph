# Server, identity and addressed messages

Agreed and initially implemented 2026-09-04. Core owns the message envelope,
durable acceptance, reply attribution and addressed output. `@endograph/server`
is a separate package with a per-machine Fetch handler over those files.

## Trust boundary

Permission to write inbox files includes permission to assert any valid `from`.
Core checks syntax, not whether the assertion is true. When `from` is absent,
the file binding resolves the existing procedure-run context, then falls back
to the file's OS owner. A same-user file becomes `local:<username>`; another
uid becomes `local:uid:<number>`. Filesystem readers retain filesystem access
to all output. Remote read restrictions are enforced by the server.

Identities are `scheme:id`: a lowercase scheme followed by a nonempty identifier,
without whitespace/control characters, at most 2048 characters total. Examples:
`local:eleven`, `agent:endofrog`, `agent:endofrog/deploy`, `timer:nightly`,
`oidc:https://issuer.example#subject`. Identity comparisons are exact; adapters
must choose stable canonical identities. Display names are not account keys.

The server's `authenticate(request)` returns a verified identity or null. Its
implementation owns credential verification and admission. Once admitted, a
caller can submit requests and invoke every exposed procedure on every agent
configured in that server, and read output addressed to its identity. There is
no separate read/write role configuration in this first implementation.

The server constructs `from`, `to`, timestamps and internal IDs. HTTP bodies
cannot set `from`, `to`, `run`, `agent` or `cause`. `origin` is unverified context.
An authentication failure exposes neither agent availability nor output.

## Attribution and procedure checks

The originally accepted envelope owns authorship. Retrying its ID does not
change its author or payload. Every newly committed reply carries the answering
agent in `from` and the accepted author in `to`, including working acknowledgements,
terminal failures and rejections. Core overrides reply destinations; an agent
or procedure cannot redirect its completion reply. Archive rebuilding preserves
both fields. Older replies without `to` are not exposed remotely.

`caller()` from `endograph/procedure` returns `{ from, id }` for the current run.
The harness supplies it independently of procedure arguments. A model-started
procedure sees the agent as caller; a direct remote call sees the remote identity.
Rare entry-point restrictions belong in ordinary procedure code:

```ts
import { procedure, caller } from "endograph/procedure";

await procedure({ description: "restricted maintenance", expose: true });
if (caller().from !== "local:eleven") throw new Error("caller not allowed");
// Perform the maintenance operation.
```

This checks that entry point. It does not prevent the same operation through
another procedure, bash or a host action. Host actions still execute under the
agent's owner-granted authority, not a remote caller's delegated credentials.
Instructions may express behavioral preferences, but are not enforced checks.

## Recipients, notifications and routing

`from` and `to` use the same identities. `emitMessage({ text, to?, ref? })`:

- Defaults to the procedure's own agent. Bare names abbreviate `agent:<name>`.
- Sends a request to a registered local agent's inbox; its receipt can be used
  with `waitForCompletion`.
- Queues a notification for any other valid identity in the sending agent's
  inbox. The harness archives it before publishing `outbox/messages/<id>.json`.
  It does not wake the model. Its receipt has `notification: true`, and
  `waitForCompletion` rejects it immediately.

Notifications carry the procedure's identity in `from`, the recipient in `to`,
and the current run ID in `cause`. A causal link records who caused work without
impersonating them or conveying their authority. A direct call's run ID is its
request ID; model-started runs have their own IDs. This is not a complete
delegation chain through arbitrary model activations.

An unregistered local agent is also a valid pending notification destination.
The initial implementation does not automatically reroute it when that agent
registers. A binding can collect addressed output non-destructively. A read is
not a delivery acknowledgement; messages remain available with no expiry or
automatic cleanup. There is no completion reply for a notification. Startup
repairs notification files from the archive, including after SQLite rebuilding.

Requests/calls explicitly addressed to a different agent than the receiving
inbox are rejected. Reply routing uses the accepted author, never the incoming
request's `to`.

## HTTP surface

Create one handler with an owner-selected map of agent names to state directories.
The handler never accepts filesystem paths from clients. The embedding starts
the HTTP listener and owns TLS and credential verification.

```ts
import { createServer } from "@endograph/server";
import { verifyCaller } from "./authentication.ts";

Bun.serve({
  hostname: "127.0.0.1",
  port: 4318,
  fetch: createServer({
    agents: { endofrog: "/srv/endofrog/.endo" },
    authenticate: verifyCaller,
  }),
});
```

`verifyCaller` is owner-supplied code returning `Promise<string | null>` or
`string | null`; it is not a bundled adapter. Do not implement it by copying an
unverified identity header from an Internet client. For provider events, the
adapter must verify the provider and derive the sender from verified event data.
Provider-specific normalization and intermediary provenance are not built yet.

| Operation | Behavior |
| --- | --- |
| `POST /agents/:agent/messages` | Accept `{ id?, kind?: "request", text, ref?, origin? }`, or `{ id?, kind: "call", procedure, args, ref?, origin? }`. Return `202 { id }` after the inbox file is flushed. This is queued, not executed. |
| `GET /agents/:agent/replies/:id` | Return the latest reply only when `to` equals the authenticated identity. Missing, not-yet-published and unauthorized replies all return 404. |
| `GET /agents/:agent/messages` | Return `{ messages }`, containing notifications addressed to this caller. |
| `GET /agents/:agent/messages/:id` | Return one addressed notification; missing and unauthorized return 404. |

Admission defaults to all configured agents and exposed procedures. There are
no endpoints for logs, histories, raw outboxes, arbitrary status files or host
administration. All responses disable caching. Bodies are limited to 1 MiB by
default (`maxBodyBytes` overrides it). Malformed input is rejected before writing.

The server derives internal IDs from the tuple `(agent, caller, "id", client ID)`
using SHA-256; client IDs remain visible in the submission response and reply
endpoint. Replies to submissions from trusted local bindings can also be read
by their core ID, subject to the same recipient check. Different callers can
safely reuse a client ID. Reusing an ID as the same
caller means retrying the first accepted message. Thread keys are similarly
scoped using a separate `"ref"` domain. This prevents accidental shared thread
selection; it does not isolate all memory inside an agent whose program shares
history or state. Programs serving confidential conversations must select their
history accordingly.

## Development and remaining work

The package lives in `packages/server`, with a local development dependency on
the root `endograph` package and a peer dependency for consumers. `bun install`,
`bun run typecheck` and `bun test` from the repository root cover both packages.
It has not been published or deployed by this change.

Deferred: bundled OIDC/webhook/token adapters, richer verified provider facts,
push delivery, acknowledgements, notification pagination/retention, automatic
pending-agent routing, and a managed server CLI. The notification list currently
scans all published notifications for the selected agent. A deployment with
large queues should add pagination/indexing before relying on this endpoint.
