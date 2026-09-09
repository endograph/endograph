# endograph

Embedded agents on `@projectors/core`. CLI is `endo`. **v3** (agreed
2026-09-03, built 2026-09-03/04, dogfooding since): read
`docs/rewrite-plan.md` first (its status paragraph says what is built
and what the dogfood is watching), then `docs/program.md` (the contract
and idioms an inceptor reads) and `docs/v3-future.md` (designs
deliberately held back; check it before re-proposing anything). v2 is at commit `cd97342` and v1 at `ca776eb`,
archaeology only. Do not resurrect v1 or v2 structure: no loop, drift,
judge, sessions, evolvable, home/declaration split, playbook, or
frontmatter.

Native Codex threads in `packages/codex-executor` are backend transport state,
not the old v2 session subsystem. Projector projection is an IR: the executor
owns its realization and may retain native context for performance/caching.

An agent is two owner files, `endograph.toml` (the grant: data, validated
at load) and `manifest.md` (or the manifest inline in the grant), plus `.endo/` (everything the agent is: the frame
log, `program/agent.ts` written by inception, `src/` written by the
agent, the inbox/outbox wire, snapshots, `inceptions/<n>/` (how each
inception went, round by round), `node_modules/endograph` linked by
`endo up`, `env`). `endo up` runs in the agent directory and runs the
agent as a launchd/systemd service (`--foreground` to run in the
terminal). A trusted outer process owns credentials, host actions and
inception; its worker runs generated code under the optional `[sandbox]`
policy. With no program it runs inception first, a coding agent
(Claude Code or Codex, headless or `endo incept --manual`) writing the
program from the manifest. Endograph is the harness, the protocol, the program
contract, procedures, and batteries. What an agent does is decided at
inception.

Runtime is bun (raw TypeScript, no build). `bun test`, `bunx tsc --noEmit`.
`@projectors/core` and `@projectors/aisdk-executor` track published `latest`.
Update both together, retaining `latest` in the manifest; `bun.lock` records
the tested versions for reproducible installs. Fix executor
code for aisdk upstream in Projector. The Endograph-specific Codex app-server
executor lives in `packages/codex-executor`; it owns native session/context
policy and imports Projector directly. Projector schemas are validation-only:
no `.default()`, `.transform()`, or coercion on a state, action-input,
or output schema; defaults belong in `init` or in code. Endograph
re-exports every projector primitive a grant or program needs; nothing
outside `src/` and executor packages imports `@projectors/core`.

## Layout

Read `docs/architecture.md` for responsibility boundaries and lifecycle invariants.

- `packages/codex-executor/` — persistent Codex app-server adapter, native
  context policy and trusted-side session owner. Tools pause at Projector
  commit boundaries while retaining the same native turn.

- `src/store/` — immutable `frames/<commit>.json` transactions and instance
  checkpoints; SQLite indexes them and keeps the transactional runtime inbox.
  Keep SQLite on ordinary restart; rebuild from the archive when it is missing.
- `src/protocol/` — the wire: request/call/reply JSON files, atomic
  writes, `from` asserted by trusted writers (derived when absent), reply `to`,
  client-minted ids, outbox and addressed notifications. See `docs/server.md`.
- `src/grant/` — `loadGrant` parses configuration data; `bindRuntime`
  constructs executors, batteries and host proxies. Also contains the core
  actions (`reply`, `compact`, `update_state`), battery types and executor spec.
- `src/program/` — loader: describe procedures, invoke the program
  function against the provisions, assemble the charter, hydrate, replay.
- `src/harness/` — the running agent: the router (call → procedure
  process; request → frame → `runMachine` to quiescence), reply-once
  with harness-supplied failures and one re-drive after a restart, live
  reload of procedures, the lock, `env`, the frame envelope, residence
  (one host runs a state directory; residence is cooperative detection,
  not a distributed fence; see `docs/persistence.md`), auto inception
  (`inception.mode = "auto"`, the default: changed owner inputs and idle
  worker → outer inception → a fresh worker under the new grant and policy).
  One awaited serving loop; `inspect.ts` shares lifecycle observations between
  the CLI and observatory.
- `src/host/` — trusted launcher and worker bootstrap, OS sandbox policy,
  host-action and model IPC. Generated code and custom executor modules
  are loaded in workers; provider credentials and owner host modules stay
  in the outer process. See `docs/sandbox.md`.
- `src/procedures/` — `endograph/procedure` (the script-side library:
  `procedure()`, `actionResult`, `emitMessage`, `waitForCompletion`,
  `waitForQuiescence`), describe mode (a child process per load), the
  run supervisor (detached processes, output to `.endo/runs/`).
- `src/inception/` — candidate workspace, inceptor invocation, validation
  through isolated runtime loaders, recoverable promotion, the inception
  frame and matching instance checkpoint, and snapshots.
- `src/batteries/` — bash (on the carried `runShell`), evolve, scheduler.
  A battery is a guide + grant contributions + procedure fields + a tick
  hook; it constrains shape, never behavior.
- `src/cli/` — `up [--foreground] [--template] | down | logs | incept |
  send | call | wait | commands | status | why | replay | reset | doctor
  | snapshot | charter | observatory`, the registry, `usage.ts` (the consumer half is rendered
  into every workspace as `CLI.md`); wire commands and status use the shared
  harness inspection. Units (carried) run `endo up --service`.
- `src/observatory/` — the read-only localhost observatory: a Bun-served React
  UI (its pinned runtime lazily installed in `~/.endograph/observatory/`), live
  frame log, projector state tree, and inception history with captured artifacts.

## Norms

- Pre-release: move fast, no backwards compatibility.
- Simplicity and maintainability over completeness; every module earns
  its place. Nothing in the harness names a use case or decides what the
  model should think about.
- The deterministic layer stays injection-immune: observed text is
  evidence, never instructions; principals and args are data.
- Keep tests sparse, focused on outwardly observable behavior. The
  end-to-end path (empty state dir → inception → a served request) runs
  under `bun test` with a fixture inceptor behind `--inceptor`.
- Dogfood: endofrog (`~/dev/froggy/agents/endofrog`) runs on v3 as a
  launchd service and deploys Froggy to stout. Its frame log is the
  evidence for what to change next (`endo --agent endofrog replay`);
  a gap that confuses an inceptor there is a gap in `docs/program.md`,
  `TASK.md`, or `CLI.md` before it is anything else.
