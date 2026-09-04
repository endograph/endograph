# endograph

Embedded agents on `@projectors/core`. CLI is `endo`. **v3** (agreed
2026-09-03, built 2026-09-03/04, dogfooding since): read
`docs/rewrite-plan.md` first (its status paragraph says what is built
and what the dogfood is watching), then `docs/program.md` (the contract
and idioms an inceptor reads) and `docs/v3-future.md` (designs
deliberately held back; check it before re-proposing anything). v2 is at commit `34600c7` and v1 at `4455c59`,
archaeology only. Do not resurrect v1 or v2 structure: no loop, drift,
judge, sessions, evolvable, home/declaration split, playbook, or
frontmatter.

An agent is two owner files, `endograph.ts` (the grant: `defineAgent`)
and `manifest.md`, plus `.endo/` (everything the agent is: the frame
log, `program/agent.ts` written by inception, `src/` written by the
agent, the inbox/outbox wire, snapshots, `node_modules/endograph` linked
by `endo up`, `env`). `endo up` runs in the agent directory and runs the
agent as a launchd/systemd service (`--foreground` to run in the
terminal); with no program it runs inception first, a coding agent
(Claude Code or Codex, headless or `endo incept --manual`) writing the
program from the manifest. Endograph is the harness, the protocol, the program
contract, procedures, and batteries. What an agent does is decided at
inception.

Runtime is bun (raw TypeScript, no build). `bun test`, `bunx tsc --noEmit`.
`@projectors/core` and `@projectors/aisdk-executor` are bun links into the
projector monorepo at `~/dev/projector` (core in `packages/projector`);
fix the executor there, not here. Projector schemas are validation-only:
no `.default()`, `.transform()`, or coercion on a state, action-input,
or output schema; defaults belong in `init` or in code. Endograph
re-exports every projector primitive a grant or program needs; nothing
outside `src/` imports `@projectors/core`.

## Layout

- `src/store/` — carried from v2: append, read from seq, snapshot; SQLite.
- `src/protocol/` — the wire: request/call/reply JSON files, atomic
  writes, `from` stamped by the binding, client-minted ids, outbox.
- `src/grant/` — `defineAgent`, the core actions (`reply`, `compact`,
  `update_state`), battery types, the executor spec (carried).
- `src/program/` — loader: describe procedures, invoke the program
  function against the provisions, assemble the charter, hydrate, replay.
- `src/harness/` — the running agent: the router (call → procedure
  process; request → frame → `runMachine` to quiescence), reply-once
  with harness-supplied failures and one re-drive after a restart, live
  reload of procedures, the lock, `env`, the frame envelope.
- `src/procedures/` — `endograph/procedure` (the script-side library:
  `procedure()`, `actionResult`, `emitMessage`, `waitForCompletion`,
  `waitForQuiescence`), describe mode (a child process per load), the
  run supervisor (detached processes, output to `.endo/runs/`).
- `src/inception/` — workspace rendering, inceptor invocation,
  validation rounds, the inception frame and snapshots.
- `src/batteries/` — bash (on the carried `runShell`), evolve, scheduler.
  A battery is a guide + grant contributions + procedure fields + a tick
  hook; it constrains shape, never behavior.
- `src/cli/` — `up [--foreground] [--template] | down | logs | incept |
  send | call | wait | commands | status | why | replay | reset | doctor
  | charter`, the registry, `usage.ts` (the consumer half is rendered
  into every workspace as `CLI.md`); units (carried) run `endo up
  --service`.

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
