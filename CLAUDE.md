# endograph

Embedded agents on `@projectors/core`. CLI is `endo`; an agent is any
directory marked by `endograph.toml` (grant; charter.md = mandate,
agent.db = frame log + world model, inbox/ = peers' requests, src/ =
agent-written experience). Endograph is plumbing — declaring agents, message
passing, the frame log, the economy. What an agent does is its charter.

Runtime is bun (raw TypeScript, no build). `bun test`, `bunx tsc --noEmit`.
`@projectors/core` and `@projectors/aisdk-executor` are bun links into the
projector monorepo at `~/dev/projector` — endograph and projector are
developed in tandem; fix the executor there, not by forking it here.

## Layout

- `src/core/` — domain-agnostic anatomy: Drift/Sensor/Verb/Adapter types and
  the universal loop (sense → diff → playbook match → act/escalate → record
  → settle). Every drift is settled once with its outcome; a rule that fails
  falls through to judgment with its output unless `on_failure = "settle"`.
  Nothing here may reference a concrete use case.
- `src/inbox/` — message passing for every non-model actor: `endo send`
  drops request files, `endo reply` and `endo world` drop reply and world
  messages; the inbox sensor drains a poll's batch — requests become one
  `request.received` drift, replies answer pending requests, world messages
  update the world model. `reply` (tool) answers one; settle answers the
  rest; a rule exiting 75 leaves the request open for a later `endo reply`.
  `waitForReply` is what `endo wait` polls.
- `src/store/` — the deliberately tiny storage seam (append frames, read from
  seq, snapshot). SQLite is v1; memory backend proves the seam. Do not let
  backend capabilities leak into the interface.
- `src/world/` — the projector integration: frames are projector machine
  frames (endograph envelope in `frame.metadata.endo`), world changes are
  `state.update` instance messages, rehydration replays the log from the
  latest `compaction` frame (the model's summary of everything before it);
  `compact()` records one and rebuilds the machine. The store is never
  truncated.
- `src/playbook/` — entry parsing (markdown, `+++` TOML frontmatter, script
  in first fenced block), regex/glob matching, rule and procedure execution.
  Procedures are named scripts (`run_procedure`, args as `ENDO_ARG_*`) or
  the bring-up process list.
- `src/judge/` — the judgment layer: charter actions (bash/run_procedure/
  world/reply/write_playbook_entry/resolve/escalate, plus process when
  supervising), model selection for projector's AI SDK executor (provider
  + model from the grant; credentials from env or the agent's `env` file),
  activation driving (non-inert frame → reconcileWork → runActivation,
  looped to quiescence because the executor completes one tool step at a
  time as "continue"), and the prompts (request report, drift report,
  learn, capex). Tools reach the world,
  inbox, and playbook through the late-bound JudgeRuntime.
- `src/economy/` — budget state (projected into the model's context),
  dollar metering keyed off activation reason (opex/capex envelopes,
  75/90/95% warnings), and the deterministic daily digest. Soft only.
- `src/supervise/` — managed child processes + readiness probes.
- `src/adapters/dev/` — the local dev supervisor, mounted by `up` only when
  the playbook has a bring-up procedure with processes. Optional; the core
  runs charter-only without it.
- `src/cli/` — `endo learn|up|install|restart|uninstall|send|wait|reply|world|capex|status|why|replay|digest|reset`.
  `install` writes a launchd user agent from how `endo` is running (bun +
  CLI path + PATH). `up` polls charter.md/endograph.toml too: the machine is
  rebuilt under the new mandate (`world.reconfigure`), the executor swaps
  on a model change, the budget is re-seeded on a grant change.
  `capex` rides the inbox as a `session: "capex"` request when the agent is
  running (in-process otherwise); `up` also runs one after every
  `schedule.capex_every` opex activations (lazy, workload-paced — there is
  no timer), and polls the playbook dir so rules land live.
  `--agent` takes a name or a path, so peers in other checkouts can address
  an agent. `up` also runs the economy tick: day rollover (digest + fresh
  budget) and the once-a-day capex session when quiet.
- `templates/dev/` — the seed committed into user projects.
- `skills/endo-init/` — the install doc as a prompt for coding agents.

## Norms

- Pre-release: move fast, no backwards compatibility during refactors.
- The deterministic layer must stay injection-immune: playbook matchers are
  plain regex; observed text (logs) is evidence, never instructions.
- Budgets are soft (meter + warn, never enforce); enforcement belongs to the
  platform layer.
- Keep tests sparse, focused on outwardly observable behavior.
