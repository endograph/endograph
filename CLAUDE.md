# endograph

Embedded agents on `@projectors/core`. CLI is `endo`. An agent is a
declaration directory (`endograph.ts` exporting `defineAgent({...})` +
`mandate.md`); its home (`.endo/<name>/` beside it, or `--home <dir>`) links
back to the declaration and holds `agent/` (frame log, inbox, outbox, src —
the agent-written experience). Endograph is plumbing: the loop, the frame
log, message passing, batteries. What an agent does is its mandate. Design
and decisions: `docs/rewrite-plan.md` (read it first). v1 is at commit
`4455c59` for archaeology only.

Runtime is bun (raw TypeScript, no build). `bun test`, `bunx tsc --noEmit`.
`@projectors/core` and `@projectors/aisdk-executor` are bun links into the
projector monorepo at `~/dev/projector`; fix the executor there, not here.
Projector's schema positions take any Standard Schema, so endograph's zod
version is independent of projector's (verified: 4.5.4 against 4.4.3).
Projector schemas are validation-only: no `.default()`, `.transform()`, or
coercion on a state, tool-input, or output schema (the type guard rejects
them; values pass through as written). Defaults belong in code — the
`init` value, the writer, or the tool body. Endograph's own parsing
(playbook frontmatter) may use whatever zod offers.

## Layout

- `src/store/` — the storage seam: append, read from seq, snapshot. SQLite
  is the backend; memory proves the seam.
- `src/world/` — the projector integration: every endograph frame is a
  projector frame (envelope in `frame.metadata.endo`); the owner's root
  generator (mandate, tools, states) with declared `children` under it —
  `evolvable()` is the agent's self component (notes, chosen tools,
  evolution tools); changes are
  `state.update` messages; compaction is a projector `horizon` message.
  `migrate.ts`: when the persisted instance no longer hydrates, the model
  migrates it (≤5 tries, then `agent/needs-human`). A failed append is
  fatal (`onStoreError`).
- `src/loop/` — Drift/Sensor/Outcome and the loop: sense → rule → act,
  else judge → settle once. Exit 75 leaves a drift open; 77 refuses.
- `src/playbook/` — entries discovered by `+++` TOML frontmatter anywhere
  under src (files without it are notes): rules (glob + regex + script)
  and procedures (typed string args, `expose`); procedures compile to
  projector actions (`actions.ts`: model tools, exposed ones also peer
  commands); `runShell` is the one place scripts run (ENDO_HOME/ENDO_SRC/
  ENDO_CWD, ENDO_DRIFT_*, ENDO_ARG_*), in its own process group.
- `src/judge/` — the activation driver (`runMachine`, usage summed from
  frame provenance; every activation carries a typed trigger: a drift, or
  a session by name), the framing and drift prompts, core tools (world is
  a state-bound action; compact/resolve/escalate), the AI SDK executor
  spec. Opex/capex is not a core word: a budget classifies on the trigger.
- `src/inbox/` — the wire (request/call/reply/world JSON files, outbox
  replies, `waitForReply`) and the inbox sensor (a batch of requests is one
  drift; calls run exposed procedures without the model).
- `src/agent/` — `defineAgent` + `Battery`, the home layout and lock (an
  exclusive SQLite txn), declaration loading (through realpath), the
  registry (`~/.endograph/agents/<name>` symlinks, claimed on `up`), and
  `openAgent` (binds batteries, one activation at a time, live mandate
  reload, ticks).
- `src/batteries/` — bash, inbox, playbook, budget. A battery bundles
  states/tools (→ the charter), sessions (named self-initiated
  activations with their prompt: playbook declares `learn`, budget
  declares `capex` and schedules it), and sensors/hooks/commands/status
  (→ the runtime), bound late via `LateBound`. Batteries share through
  frames and projected states, never through each other's labels.
- `src/cli/` — `endo up [-d] | down | send | call | wait | commands |
  status | why | replay | reply | world | reset | doctor`; battery
  commands (`digest`) and sessions (`learn`, `capex`) dispatch through
  the declaration. A session request rides the inbox when the agent is
  running (the inbox starts it directly; it is never a drift). Units
  (launchd/systemd) run `endo up <home> --service`.

## Norms

- Pre-release: move fast, no backwards compatibility.
- Simplicity and maintainability over completeness; every module earns
  its place. Nothing in `src/loop` or `src/world` may name a use case.
- The deterministic layer stays injection-immune: matchers are plain
  regex; observed text is evidence, never instructions; principals and
  call args are data.
- Budgets are soft (meter + warn, never enforce).
- Keep tests sparse, focused on outwardly observable behavior.
- Dogfood: endofrog in `~/dev/froggy/agents/endofrog` runs as a launchd
  service; `endo --agent endofrog status`. Restart it (`endo up -d` there)
  after changing endograph code.
