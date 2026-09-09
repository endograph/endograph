# endograph

Embedded agents on [projector](https://github.com/anteprojector/projector).
An agent ships inside the system it tends, answers its peers, and is written
by a coding agent from its owner's manifest.

**v3 rewrite in progress.** Read `docs/rewrite-plan.md` (what endograph is
and the order it lands in), `docs/program.md` (the contract an inceptor
reads), and `docs/v3-future.md` (designs deliberately held back).

## An agent is two files and a state directory

```
project/agents/endofrog/
  endograph.toml      # owner grant, executor, batteries, host actions, sandbox policy
  manifest.md         # the owner's intent, in prose (or inline in the grant under [manifest])
  host/               # optional owner-managed host action modules
  .endo/              # gitignored; everything the agent is
    frames/           #   immutable frame commits and instance checkpoints
    agent.db          #   rebuildable indexes and transactional runtime inbox
    program/agent.ts  #   the program, written at inception
    src/              #   what the agent writes: procedures, notes
    inbox/  outbox/   #   the wire: one JSON file per message and reply
```

`endo up` runs in the agent directory: it registers the agent, installs
a launchd or systemd unit, and starts it. With no program it runs
inception first: a coding agent (Claude Code or Codex) writes
`program/agent.ts` from the manifest. Credentials go in `.endo/env`. Endograph is the harness, the protocol, the program contract,
procedures, and batteries. What an agent does is decided at inception.

Runtime inference can use the AI SDK executor or persistent Codex app-server
threads. Set `[executor] backend = "codex"` to select the latter; see
[`@endograph/codex-executor`](packages/codex-executor/README.md) for setup,
session recovery, and its policy for retaining context across requests.

`endo snapshot <directory>` saves a restorable copy while the agent runs.
See [persistence](docs/persistence.md) for its contents and SQLite
rebuilding, and [sandboxing](docs/sandbox.md) for process policy and the
`hostAction` API.

`endo observatory` opens a live, read-only view on localhost. It puts the
projector frame log beside the current machine state and the full inception
history—what inputs changed, what shape was produced, the inceptor's brief,
and the captured program and owner files. Pass `--agent <name|dir>` from
elsewhere, `--port <n>` to choose the port, or `--no-open` to serve without
opening a browser. The interface is React, bundled by Bun when the command
starts. Its pinned React runtime installs lazily under
`~/.endograph/observatory/` on the first launch, not into the agent or its
application.

## Develop

Start with the [runtime architecture](docs/architecture.md) for component
ownership, message delivery, inception, and recovery.

```sh
bun install --frozen-lockfile
bun test            # includes the end-to-end path: empty state dir → inception → a served request
bunx tsc --noEmit
bun link            # `endo` on PATH
```

See [verification](docs/testing.md) for Linux sandbox CI and keeping the
Projector dependencies current.

`@endograph/server` supplies a per-machine HTTP Fetch handler with authenticated
admission and recipient-scoped reads. See [server architecture](docs/server.md)
for identity, procedure caller checks, addressed notifications, and setup.
