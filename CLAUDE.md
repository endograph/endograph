# endograph

Embedded agents on `@projectors/core`. CLI is `endo`. **v3 rewrite in
progress** (agreed 2026-09-03): read `docs/rewrite-plan.md` first, then
`docs/program.md` (the contract and idioms an inceptor reads) and
`docs/v3-future.md` (designs deliberately held back; check it before
re-proposing anything). v2 is at commit `34600c7` and v1 at `4455c59`,
archaeology only. Do not resurrect v1 or v2 structure: no loop, drift,
judge, sessions, evolvable, home/declaration split, playbook, or
frontmatter.

An agent is two owner files, `endograph.ts` (the grant: `defineAgent`)
and `manifest.md`, plus `.endo/` (everything the agent is: the frame
log, `program/agent.ts` written by inception, `src/` written by the
agent, the inbox/outbox wire, snapshots). `endo up` runs in the agent
directory; with no program it runs inception, a coding agent (Claude
Code or Codex, headless or `endo incept --manual`) writing the program
from the manifest. Endograph is the harness, the protocol, the program
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

## Layout (target; see the plan's §16 for the order it lands in)

- `src/store/` — carried from v2: append, read from seq, snapshot; SQLite.
- `src/protocol/` — the wire: request/call/reply JSON files, atomic
  writes, `from` stamped by the binding, client-minted ids, outbox.
- `src/grant/` — `defineAgent`, the core actions (`reply`, `compact`,
  `update_state`), battery types, the executor spec (carried).
- `src/program/` — loader: describe procedures, invoke the program
  function against the provisions, assemble the charter, hydrate, replay.
- `src/harness/` — `endo up`: the router (call → procedure process;
  request → frame → `runMachine` to quiescence), reply-once with one
  re-drive, live reload of procedures, the lock.
- `src/procedures/` — `endograph/procedure` (the script-side library:
  `procedure()`, `actionResult`, `emitMessage`, `waitForCompletion`,
  `waitForQuiescence`), describe mode, the run supervisor.
- `src/inception/` — workspace rendering, inceptor invocation,
  validation rounds, the inception frame and snapshots.
- `src/batteries/` — bash (on the carried `runShell`), later scheduler
  and evolve. A battery is a guide + grant contributions + procedure
  fields + hooks + commands; it constrains shape, never behavior.
- `src/cli/` — `up [-d] [--template] | down | incept | send | call |
  wait | commands | status | why | replay | reset | doctor | charter`;
  units (carried) run `endo up --service`.

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
- Dogfood: endofrog (`~/dev/froggy/agents/endofrog`) is **down** until
  v3 can incept it (plan §16 step 8). Its inception 1 is done by hand
  with `endo incept --manual` in Claude Code; what `TASK.md` needs to
  say is learned there.
