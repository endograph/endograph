# endograph

[Website](https://endograph.github.io/endograph/)

Endograph runs agents in your infrastructure, using
[projector](https://github.com/endograph/projector). You give an agent a
manifest describing its job and permissions for what it can access. A coding
agent writes its program. Once running, it receives messages and develops
its own tools and notes.

The v3 rewrite is in progress. `docs/rewrite-plan.md` describes the scope
and implementation order. `docs/program.md` defines the program contract
used during inception. Deferred ideas are in `docs/v3-future.md`.

## Agent files

```
project/agents/endofrog/
  endograph.toml      # owner grant, executor, batteries, host actions, sandbox policy
  manifest.md         # the owner's intent, in prose (or inline in the grant under [manifest])
  .env                # owner credentials, gitignored; loaded by the host
  host/               # optional owner-managed host action modules
  .endo/              # agent-managed state and local runtime files
    frames/           #   immutable frame commits and instance checkpoints
    agent.db          #   rebuildable indexes and transactional runtime inbox
    program/agent.ts  #   the program, written at inception
    src/              #   what the agent writes: procedures, notes
    inbox/  outbox/   #   the wire: one JSON file per message and reply
```

Run `endo up` in the agent directory. It registers the agent, installs
a launchd or systemd service, and starts it. If the agent has no program,
Endograph runs inception first: a coding agent (Claude Code or Codex)
writes `program/agent.ts` from your manifest.

Put credentials in `.env` beside `endograph.toml` and add it to your
project's `.gitignore`. Existing process environment variables take
precedence over `.env`. If you're upgrading from the old layout, move
`.endo/env` to `.env`; Endograph no longer loads the old path.

Configure the agent through these owner files. You don't need to edit
anything inside `.endo/`. Endograph handles running the program and
delivering messages, and provides the program contract, procedures, and
optional capabilities called batteries. Inception determines how the agent
does its job.

## Model access

The agent can use the AI SDK executor or persistent Codex app-server
threads. To use Codex, set `[executor] backend = "codex"`. The
[`@endograph/codex-executor`](packages/codex-executor/README.md) README
explains setup, session recovery, and how context carries across requests.

## Snapshots and inspection

Run `endo snapshot <directory>` to save a restorable copy while the agent
runs. The [persistence docs](docs/persistence.md) explain what the snapshot
contains and how Endograph rebuilds SQLite. The
[sandboxing docs](docs/sandbox.md) cover process permissions and the
`hostAction` API for actions that run on the host.

`endo observatory` opens a live, read-only view on localhost. You can inspect
the Projector frame log, current machine state, and inception history. Each
inception record includes the changed inputs, the resulting program
structure, the coding agent's brief, and copies of the program and owner
files.

Use `--agent <name|dir>` to inspect an agent from another directory,
`--port <n>` to choose a port, or `--no-open` to leave the browser closed.
Bun bundles the React interface when the command starts. The first launch
installs a pinned React runtime under `~/.endograph/observatory/`, outside
the agent and its application.

## Develop

Read the [runtime architecture](docs/architecture.md) before changing the
code. It explains which components own each part of the runtime and how
message delivery, inception, and recovery work.

```sh
bun install --frozen-lockfile
bun test            # includes the end-to-end path: empty state dir → inception → a served request
bunx tsc --noEmit
bun link            # `endo` on PATH
```

The [testing docs](docs/testing.md) cover Linux sandbox CI and updating
the Projector dependencies.

`@endograph/server` provides an HTTP Fetch handler for each machine. It
authenticates callers and restricts reads to the intended recipient.
The [server docs](docs/server.md) explain setup, caller identity checks,
and notifications sent to specific recipients.
