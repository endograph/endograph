# Runtime architecture

An agent has one running program generation. Inception builds its replacement
in a candidate directory, validates it, and commits the new program with its
instance checkpoint. The parent then starts a fresh worker. Recovery uses the
same startup path.

## Who owns what

| Component | Responsibility | Entry point |
| --- | --- | --- |
| Owner configuration | Manifest, grant selections, process policy | [`loadGrant`](../src/grant/grant.ts) |
| Trusted parent | Credentials, host handlers, model access, inception authorization, worker lifetime | [`createAgentHost`](../src/host/agent.ts) |
| Worker | Bind provisions, load one program generation, serialize activations and procedure reloads | [`openAgent`](../src/harness/agent.ts) |
| Inspection | Interpret status, locks, inception records and service state for every user interface | [`inspectAgent`](../src/harness/inspect.ts) |
| Procedure supervisor | Start processes, observe acknowledgements and exits, retain recovery files until the harness publishes a reply | [`createRuns`](../src/procedures/runs.ts) |
| Store | Archive commits, checkpoints, inbox transactions, canonical replies | [`openSqliteStore`](../src/store/sqlite.ts) |

`loadGrant` and `inceptionStatus` inspect data without executing generated
code. `bindRuntime` constructs executable provisions. `validateProgram`
explicitly runs a dry load, using an isolated worker when hosted. A sandboxed
grant requires that isolation; there is no local fallback.

## Serving a message

The harness accepts an inbox file into SQLite before removing the file. A
request becomes a machine frame and is marked delivered in one transaction.
A call is recorded before its procedure starts. The machine runs to quiescence;
procedure processes can continue independently after acknowledging their call.

One awaited serving loop polls, runs due battery ticks, and waits. It schedules
the next pass only after the current pass finishes; long activations cannot
accumulate timer callbacks. Due ticks use the current time once, without
replaying missed intervals. Explicit poll/reload/tick calls use the same serial
queue. Shutdown fences that queue immediately, wakes an idle loop, lets the
current turn finish, and releases the store and lock once. Persistence failures
retain the fatal shutdown path described below.

Appending a request or call frame indexes its delivered messages using the same
function as archive recovery. SQLite owns deduplication; the harness keeps no
second set of delivered IDs and makes no separate delivery-marker write.

The harness commits a reply before writing its outbox file. The store preserves
the first terminal reply; recovery republishes that canonical value. The
procedure supervisor never publishes directly. Its completion promises settle
only after the harness callback succeeds, and its recovery files stay until then.

`protocol/wire.ts` defines terminal replies and the shared reply wait. A
procedure can acknowledge, message its own agent, and await that message's
answer because its first reply releases the model's tool call.

The CLI and observatory consume the same inspection result: active, idle,
starting, incepting, or down, with a reason when the agent cannot serve.
`status.json` supplies observations; the local lock and inception record decide
whether a worker is serving. A stale `running` flag does not prove liveness.
Inspection reports invalid owner inputs and recorded load failures without
importing generated code.

## Changing the agent

Procedure edits reload between activations. The loader hydrates the current
checkpoint, restores history, and applies later frames. Only compaction reduces
the history presented to the model.

Owner edits request inception when the worker is idle. The parent checks the
owner inputs and allows one attempt per observed input revision. It owns retry
suppression; a worker cannot bypass it by sending another IPC request. The
running generation's auto/manual policy governs this transition, so an auto
agent can adopt a new grant that selects manual mode.

Each inception round runs the candidate through one validation. Success carries
the serialized instance forward into promotion; generated code is not invoked
again to obtain another instance. The archive commit decides whether promotion
recovery keeps the new files or restores the backup. A committed generation
requires a fresh worker even if final cleanup fails.

## Recovering and cancelling

Immutable archive files are the durable frame and checkpoint record. SQLite
indexes them and owns pending delivery. Normal restart retains SQLite; restoring
without it rebuilds from the archive. Pending inbox work absent from the archive
can be lost in that kind of restore. See [persistence](persistence.md).

If a failed write leaves the in-memory machine or commit outcome uncertain,
stop the worker and reopen. Do not repair the live machine in place or continue
through a poisoned store.

Native parent/child IPC carries both host actions and model streams. Dispatch
computes a result; the broker owns completing the request. Cancellation stops
replies and signals the handler. A handler that ignores cancellation still
occupies capacity until it settles. Current grants are checked on every host
action invocation, including calls through an old proxy. See
[sandboxing](sandbox.md) for the enforced process boundary.

## Codex executor

`packages/codex-executor` implements `ProjectorExecutor` using a persistent
`codex app-server` stdio connection. The parent owns that process and its
per-generator session associations. The worker lowers Projector context into
serializable IR and dispatches dynamic tool calls through Projector actions.
The existing model IPC carries turns, tool callbacks and checkpoint messages;
only the parent selects the executable and model. Worker exit closes the
app-server. Validation loads do not start it.

Context realization belongs to the executor: updated projections are appended
to a native thread, and Projector compaction does not force a session reset.
State/action semantics remain Projector's. Session metadata under `.endo/codex`
is parent-only and not included in snapshots. Clean restarts resume; uncertain
turns are replaced using Projector context. See the
[package documentation](../packages/codex-executor/README.md) for details.

## Keeping the foundation small

Prefer a single owner for each decision and an explicit operation for each
effect. Add a lifecycle state only when it represents something existing state
cannot express. Keep transaction ordering visible and use cold recovery after
uncertain writes. Avoid compatibility paths while the project is pre-release.

The behavioral tests cover history/compaction, self-messaging, reply publication,
interrupted promotion, archive restore, grant revocation, IPC cancellation, and
real sandbox execution. Run `bun test` and `bun run typecheck`; platform coverage
and dependency setup are documented in [verification](testing.md).
