# @endograph/server

One per-machine HTTP Fetch handler for Endograph agents. Authenticate at the
edge, submit to local inboxes, and read replies/notifications addressed to the
authenticated identity.

Install with `bun add @endograph/server`. Endograph is a runtime dependency
and is installed automatically; no separate global installation is required.

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

`verifyCaller` is your credential verifier returning a stable `scheme:id`
identity or null. Admitted callers can invoke every exposed procedure on the
configured agents and read only output addressed to them. The embedding owns
TLS and authentication provider configuration. No providers are bundled yet.

- POST `/agents/:agent/messages`: `{ id?, text, ref?, origin? }`, or
  `{ id?, kind: "call", procedure, args, ref?, origin? }`; returns `202 { id }`.
- GET `/agents/:agent/replies/:id`: the caller's reply, or 404.
- GET `/agents/:agent/messages`: `{ messages }` addressed to this caller.
- GET `/agents/:agent/messages/:id`: one addressed notification, or 404.

IDs and thread keys are scoped by caller. Identity overrides are rejected.
Reads are non-destructive; collecting a notification does not acknowledge
delivery. There are no remote history or administration endpoints.

The repository's `docs/server.md` describes the complete trust and routing
contract, procedure caller checks, recovery, limitations and deferred work.
