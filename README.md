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
  endograph.ts        # the grant: defineAgent({ name, manifest, executor, cwd, batteries })
  manifest.md         # the owner's intent, in prose
  .endo/              # gitignored; everything the agent is
    agent.db          #   the frame log and machine snapshot
    program/agent.ts  #   the program, written at inception
    src/              #   what the agent writes: procedures, notes
    inbox/  outbox/   #   the wire: one JSON file per message and reply
```

`endo up` runs in the agent directory: it registers the agent, installs
a launchd or systemd unit, and starts it. With no program it runs
inception first: a coding agent (Claude Code or Codex) writes
`program/agent.ts` from the manifest. Credentials go in `.endo/env`. Endograph is the harness, the protocol, the program contract,
procedures, and batteries. What an agent does is decided at inception.

## Develop

```sh
bun install         # @projectors/core and the AI SDK executor are bun links to ~/dev/projector
bun test            # includes the end-to-end path: empty state dir → inception → a served request
bunx tsc --noEmit
bun link            # `endo` on PATH
```
