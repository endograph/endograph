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
The parent requests graceful shutdown through private IPC so it reaches the
worker through Linux sandbox wrappers, with a forced-stop timeout as fallback.
The worker logs why it stops, and its exit code tells the parent what follows:
78 starts a fresh worker for a new program, 79 means another machine adopted
the agent and the parent stops too, and other failures end the parent so the
service manager reruns startup. A clean exit the parent did not request, such
as a signal that reached only the worker, starts a fresh worker with backoff:
service managers restart only failures, so ending the parent would leave the
agent down.

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

### Interactive inception

`endo incept --interactive` passes a native editor callback (Codex or Claude Code) into the same
inception pipeline as headless execution. It uses the terminal and authenticated
finish handoff shared with prefab setup. The harness holds the agent lock for the
whole editing/validation cycle; each explicit finish validates only the staged
candidate through the trusted host's isolated loader. Validation failure supplies
`ERRORS.md` and reopens the same native conversation, within the configured round limit.
Only successful validation reaches the promotion transaction.

Interactive sessions may edit the staged `manifest.md` and `endograph.toml` only
when the owner explicitly requests it; this is a prompting rule, not an approval
protocol. The staged `manifest.md` represents the configured manifest file even
when its published path differs; inline manifests remain in the config. The host
parses final inputs with paths resolved relative to the live owner directory and
validates using that final grant, including its sandbox and executor. Owner files,
program, migrated instance, snapshot, and recorded input hashes are promoted as
one recoverable generation. Cancellation preserves draft inputs; rollback restores
live inputs with the old program. Edits made separately to live inputs still
invalidate the draft. Headless inception gets protected copies and cannot read or
write the live owner files.

An interrupted session leaves its candidate and per-round evidence intact. Its
thread ID, cumulative round count, and source fingerprint live under
`.endo/local/inception`, outside snapshots. Repeating the interactive command
resumes that candidate. Changes to owner inputs, Endograph version, live program
or src, or committed frame position invalidate the draft's baseline; the previous
candidate is retained locally and a fresh one starts. Publication also checks
that fingerprint to avoid replacing work changed during the conversation.

`endo up --interactive` uses this path when inception is needed, then follows the
normal startup lifecycle. The flag is not installed into the service or used by
later automatic inception. Existing `--manual` and `--accept` remain available.

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

A host action's context also carries `emitMessage({ text, ref?, thread? })`, for
work that outlives the call: the action starts it, returns, and emits when it
ends. The parent writes a request from `agent:<name>/<action>` to the agent's
own inbox, the same delivery as a procedure's `emitMessage`. Pass the
originating request's `ref` so the agent can give its terminal reply after
answering `working`. Validation loads cannot emit. Work the action started
lives in the parent: a restart loses it, and the open request fails as
interrupted.

## Native executors

`packages/codex-executor` implements `ProjectorExecutor` using a persistent
`codex app-server` stdio connection. `packages/claude-executor` speaks the same host
RPC and reuses the worker side; its host runs one Claude Code process per generator
through the Claude Agent SDK, with Endograph's two tools as an in-process MCP server. The parent owns that process and its
per-generator session associations. The worker lowers Projector context into
serializable IR and dispatches dynamic tool calls through Projector actions.
The existing model IPC carries turns, tool callbacks and checkpoint messages;
only the parent selects the executable and model. Worker exit closes the
app-server. Validation loads do not start it.

Context realization belongs to the executor: updated projections are appended
to a native thread, and Projector compaction does not force a session reset.
State/action semantics remain Projector's. Session metadata under `.endo/local/executors/<backend>`
is parent-only and not included in snapshots. Clean restarts resume; uncertain
turns are replaced using Projector context. See the
[Codex](../packages/codex-executor/README.md) and
[Claude](../packages/claude-executor/README.md) package documentation for details.

## Keeping the foundation small

Prefer a single owner for each decision and an explicit operation for each
effect. Add a lifecycle state only when it represents something existing state
cannot express. Keep transaction ordering visible and use cold recovery after
uncertain writes. Avoid compatibility paths while the project is pre-release.

The behavioral tests cover history/compaction, self-messaging, reply publication,
interrupted promotion, archive restore, grant revocation, IPC cancellation, and
real sandbox execution. Run `bun test` and `bun run typecheck`; platform coverage
and dependency setup are documented in [verification](testing.md).

## Prefabs and checkout identity

`endo create <prefab>` prepares owner inputs, reference skills, and a pinned local
runtime, then offers the existing `up` lifecycle. Prefabs contain declarative
setup briefs and templates, never agent programs or procedures. The CLI collects
the repository and initial intent, then opens the native coding agent (Codex, or
Claude Code; see `src/inception/harnesses.ts`) through Bun's PTY API. The owner
converses directly with it. A per-invocation authenticated loopback endpoint records
the session identity (Codex exports its thread ID; Endograph assigns Claude's with
`--session-id`) and accepts the finish handshake; the wrapper then submits the native
`/quit` or `/exit` command. A successful exit alone
does not authorize publication: the finish handshake and schema validation must
also succeed. Validation imports no generated code.

Drafts and session metadata live under `.endo/local/setup`, excluded from Git and
snapshots. `endo setup --agent <directory>` resumes the recorded native session, or
starts one around existing files when no thread is recorded. Interrupted or invalid
drafts are preserved. After a successful publication, later sessions seed the draft
from the current owner inputs. A setup lock prevents concurrent editors; owner
files changed externally during a session are never overwritten by publication.
Setup does not start or re-incept the agent, though publishing changed owner inputs
can trigger an already-running agent's normal automatic inception.
The repository's `AGENTS.md` receives a marked section pointing peers to the agent.

`name_scope = "directory"` opts into a runtime name formed from the configured
name and a hash of the canonical agent directory. Global names remain the default.
Registry, service, messaging, and worker identity all use the resolved grant name.
This lets identical checked-in owner files run in separate worktrees without
copying state or stealing another checkout's registration. Moving a directory
changes its runtime identity; stop its old service before moving it.

Agent runtime CLI commands prefer an installed local Endograph. Startup installs the
locked dependencies first, then hands off to that pinned version, so an older local
version never installs over itself; other commands use the installed version as is.
The local package therefore owns the generated program's API and service path,
even when a user starts through `npx endograph@latest`.
