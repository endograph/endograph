# @endograph/codex-executor

A Projector executor backed by **`codex app-server` over stdio JSON-RPC**.
The Endograph host owns the process, authentication and persisted thread IDs;
the worker executes Projector actions through the existing host connection.
There are no changes to Projector and no per-request `codex exec` processes.

Select it in an agent's `endograph.toml`, then restart with `endo up`:

```toml
[executor]
backend = "codex"
# model = "..."       # optional; otherwise Codex chooses its configured default
# effort = "high"
# command = "/absolute/path/to/codex"  # executable, not a shell command
# max_tool_calls = 40  # per activation, including action discovery
```

Install/sign in to Codex as the service's OS user first. The host uses that
user's Codex authentication (and inherited `CODEX_HOME`, if set). Credentials
stay outside the worker. This package does not install the CLI or copy its
credentials. Protocol smoke-tested with `codex-cli 0.153.3`; dynamic tools are
experimental, so validate upgrades against the installed binary. See the
[official app-server protocol](https://developers.openai.com/codex/app-server/).

To switch back, replace the entire executor table with the existing
`provider = "openai"` / `provider = "anthropic"` and `model` configuration.
Restarting keeps Projector's durable program, state and frames. Native Codex
sessions and cache entries do not transfer to the AI SDK executor.

## Context policy

Each Projector generator gets one Codex thread, reused across activations.
Projection is an intermediate representation, not a required exact transcript:

- First use sends the standing context, visible history and action catalog.
- Turn input respects Codex's combined one-million-character limit. If needed,
  it keeps a contiguous suffix of recent history and explicitly reports the
  omitted message count. Instructions, current state and action schemas are
  preserved in full; oversized mandatory context or the newest message fails
  explicitly. Omitted history remains in Endograph's durable log and is not
  automatically resent on later turns.
- Later turns append changed context and new history occurrences. State updates
  supersede older snapshots without rewriting the native conversation.
- Two fixed dynamic tools list and invoke current actions. Adding/removing a
  procedure changes the catalog, not the native tool definitions. Every call
  resolves and validates against the current Projector action registry.
- Projector `compact` summaries are appended. They do **not** force native
  compaction or forgetting. Codex manages its own context-window compaction.
- Changes during an action are included in its tool response. A terminal
  Projector action interrupts the native turn and completes the activation.

Tool results are held at the host until Projector commits the action's frames.
The executor returns `continue`, and the next Projector step supplies the
updated state/topology before the host releases that result into the **same
Codex turn**. Multiple generators can retain paused native turns while the
Projector scheduler chooses which generator to run next.

Projection history filtering is therefore not a confidentiality boundary for
previously supplied content. Use separate generators for separate contexts.
The first version carries the IR as JSON text; native image/audio input and
executor-owned provider tools are not supported. Ordinary actions, state,
procedures, reply semantics and structured final output use Projector's APIs.

## Lifecycle and recovery

`.endo/codex/` holds atomic per-generator thread associations and context
cursors. Codex stores native rollouts in its own home. A clean host restart
resumes those rollouts. Session metadata is protected from sandboxed workers
and excluded from `endo snapshot`: a restored agent reconstructs context from
Projector instead of attaching to a potentially newer native conversation.

Before starting a turn, the host persists an in-flight marker. The worker
stages outputs and acknowledges the context cursor. On restart, the parent
also verifies the matching activation completion in the recovered frame store:
an executor checkpoint alone does not establish a durable Projector commit.
If either confirmation is absent, the next activation starts a fresh thread.
There is no automatic replay of native tool calls. External effects interrupted
between execution and recording still have uncertain outcomes; this does not
provide exactly-once external execution. Endograph's canonical replies remain
authoritative.

Codex runs in an empty temporary working directory with native shell, apps,
plugins, MCP servers, browser, computer-use and image tools disabled. Native
file writes are denied by its read-only sandbox, and native approval requests
are declined. Agent effects go through Endograph actions in the worker and its
existing sandbox/host grants. Owner-selected executable/model configuration is
never accepted from worker requests.

`CodexExecutor.realizePrompt` returns the projection input, not an exact native
prompt. Execution reports include thread/turn IDs, latency and token usage when
Codex supplies it. A persistent process preserves conversation continuity; it
does not guarantee prompt-cache retention across idle periods.

Run `bun test packages/codex-executor/test` from the monorepo root for offline
session, action and recovery tests. The hosted integration fixture additionally
exercises the real stdio transport and parent/worker IPC without model inference.
