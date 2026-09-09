# Endograph v3 — future

Concepts we know we want and have thought about, held back from
`docs/rewrite-plan.md` until usage shows the details. Each entry says
what it is, why we want it, what we already know, and what usage has to
tell us before it is built. Nothing in the plan depends on anything here.
When an entry lands, it moves into the plan and out of this file.

## 1. Sandbox policy

Built with the host-action broker. `endo up` runs a trusted outer process
and a worker, with the worker's process tree restricted when `[sandbox]`
is declared. Host actions and model-provider access cross dedicated IPC
pipes; inception stays outside and validates generated code in workers.
See `docs/sandbox.md` for the supported policy and authoring API.

## 2. Automatic re-inception

**Built (2026-09-04)**, as `inception.mode = "auto"` (the default): the
running harness requests outer-process inception at quiescence when the owner's inputs
changed, keeps the old program on failure, and retries only when the
inputs move again (`docs/rewrite-plan.md` §9). Deliberately without the
cadence knobs once designed here (`debounce`, `minInterval`, `attempts`):
one inception at a time at quiescence is the rate limit, and a failed
inception waiting for the inputs is the give-up rule. Whether a change is
material is the inceptor's decision, made with `DIFF.md`, never the
running agent's. Still held back: the "whose fault" gate (incept on a
load failure only when the inputs changed); in practice a program that
stops loading is an endograph or owner change, and `endo up` incepts on
any load failure.

## 3. Budget battery

**What.** A projected budget state metered from execution reports in
frame provenance; 75/90/95 % warnings into the state; `endo digest`.
Soft: meter, project, warn, never enforce.

**What changed.** v2 and the first v3 draft classified every activation
as opex or capex by requiring `class` on every procedure and calling
timer-originated activations capex. That is an app-level judgment, not
a framework one. Classification, if any, is owner-provided: a function
in the grant over the message envelope, or a battery field the owner's
chosen procedures carry. Opex/capex is not a core word.

**Usage must tell us.** Whether classification is wanted at all, or
per-procedure and per-sender totals are enough.

## 4. Activation attempts and timeout in the grant

**What.** An `[activation]` table (`attempts`, `timeout`) in the grant, bounding
how many times an interrupted request is re-driven and when a running
activation is aborted.

**Now.** Hardcoded: one re-drive, a fixed timeout. Revisit when an agent
needs a different bound; the plan's reply-once rule does not change.

## 5. Typed battery fields and run wrappers

**What.** At every load the harness writes `src/procedures/endo.d.ts`
from the grant's batteries, merging each battery's fields into the
`procedure()` options interface by declaration merging, so a missing
field is a type error before it is a describe-time failure. The file is
derived from owner inputs and overwritten on load. And: a battery may
wrap a procedure run (metering, tracing).

**Now.** Battery fields are validated at describe time only; a battery's
hooks read field values from frames instead of wrapping runs.

**Usage must tell us.** Whether the inceptor and the agent get fields
wrong often enough to want the type.

## 6. Skills

**What.** A directory under `src` holding a `SKILL.md` (YAML frontmatter
with `name` and `description`, the agent-skills format; unknown fields
ignored) is a skill. A grant-provided computed part renders the catalog
of procedures and skills, one line each, and a `skill` core action
returns a skill's instructions and file list on demand, so a program can
carry many without paying for them every turn. The inceptor already
knows the format; its own skills drop into an agent unchanged.

**Now.** The model reads a file under `src` with bash.

## 7. Inert emissions

**What.** A procedure recording a state update or a note as a frame
without waking the agent: `emitState(...)` beside `emitMessage`.
Replaces v2's `world` message.

**Usage must tell us.** Whether a procedure ever needs to write memory
without the agent noticing, or whether a message that the program routes
cheaply is enough.

## 8. Messages to a fresh node, channels

**What.** `emitMessage({ text, node })` addressing a fresh isolated node
under the root, for scoped skills and noisy jobs. More broadly: history
pollution (endofrog's deploy logs beside its bespoke inquiries).
`docs/program.md` offers a child generator per request or per `ref`; no
native channel concept until a dogfood case needs one.

## 9. Procedures in other languages; durable re-runs

**What.** Shell and other languages through a thin `procedure()` over a
script. Durable re-runs in the style of recorded steps; receipts are
already durable, so nothing precludes it.

## 10. Bindings beyond the file

Core trusts inbox writers to assert `from`, derives reply `to` from accepted
authorship, and archives addressed notifications. See `docs/server.md`.

- **SSH.** Remote CLI execution: `endo --agent stout:<path> send …`
  expands to `ssh stout 'endo --agent … send --from ssh:eleven@fox …'`.
  Scheme `ssh:<user>@<host>`.
- **MCP front door.** `endo mcp --agent <name>` (stdio): `ask` =
  request, one typed tool per exposed procedure, `wait`, status as a
  resource. The procedure arg schemas are already the MCP tool schemas.
- **HTTP relay.** Initial `@endograph/server` Fetch handler built: authenticated
  admission, caller-scoped request IDs and thread keys, own-recipient reads,
  all exposed procedures, and pull-based notification collection. See
  `docs/server.md`. Still future: packaged provider adapters, provider push
  delivery, delivery acknowledgements/retention, and a managed server CLI.
- **A2A.** The first cross-machine peer beyond ssh; the reply `state`
  vocabulary is already A2A's.

## 11. `--state <dir>`

**What.** The state directory elsewhere than `.endo/` (a read-only
checkout, a service user). The agent directory records nothing about it;
the registry entry becomes a small file holding both paths instead of a
symlink. With it: host provisioning of permissions (the runtime creates
directories once and never resets modes; writes outbox files
group-readable; tolerates inbox files owned by other users; `endo
doctor` reports the effective answer).

## 12. Registry: rename and move

**What.** Renaming (`name` changed in the grant): the next `up`
registers the new name, removes any other entry pointing here, and `up
-d` replaces the unit; peers using the old name get "unknown agent".
Moves: measured that after `mv`, a running bun process keeps a cached
cwd and every spawn fails with ENOENT; the agent should detect it (stat
of own path fails while the db handle works), log one line, and exit 0
so the supervisor does not crash-loop.

## 13. System units and containers

**What.** `endo up -d --system`: a system unit with `User=endo`; needs
root. In containers `up` is the entrypoint and `-d` is an error.

## 14. Last-resort compaction

**What.** The harness compacting on its own when a program keeps
overflowing its context. The plan's floor is a `failed` reply with a
frame naming the cause and the program's own compaction routine.

**Usage must tell us.** Whether a program ever gets stuck there.

## 15. Poly-agents from one grant

**What.** A dynamic name token, `endo up --name`, so one grant runs as
several agents. Unchanged from v2, unscheduled.

## 16. Instance carry-over at re-inception

**What.** Re-incepting an agent whose persisted instance has evolved
(spawns, cedes, transitions, state updates through the evolve battery)
so that what the agent made of itself survives where it still applies
and disappears where the new program absorbs it.

**Decided 2026-09-04.** Migration is the inceptor's judgment, not a
replay. An earlier draft replayed the evolution frames onto the new
program's fresh instance and sent only conflicts to the inceptor; it was
dropped because the common case defeats it: an inception often exists
because the owner saw what the agent spawned and wrote it into the
program properly, and a replay cannot tell "absorbed" from "still
wanted". It would re-add the helper beside its replacement, and every
inception would compound it.

- *The instruction is explicit.* `instance.json` in the workspace is
  what the agent has made of itself; `TASK.md` and `docs/program.md` §9
  say to migrate it to the new program: keep what the new intent does
  not cover, drop what the new program absorbs, rename what moved,
  preserve state values and spawned children unless the change requires
  otherwise, change the minimum. Validation hydrates the edited file, so
  a bad migration fails the round, not the next `up`.
- *`EVOLUTION.md` is the context.* Every spawn, cede, transition, and
  state update since the last inception, with the activation that made
  it, that activation's trigger, and the reason the agent gave. The
  evolve actions already require `reason`, so the log reads as intent,
  not mechanics.
- *A briefing after re-inception.* Inception n ends by emitting a
  request stamped `inceptor:<n>` saying what changed, what was absorbed,
  and what moved, so the first activation on the new program is briefed
  rather than confused by tools, states, or children that vanished.
- *`docs/program.md` says why* to prefer procedures, state updates, and
  spawns over transitioning the root: they are the easiest to carry
  across an inception, and a transition replaces a node wholesale.

**Now.** The evolve battery and `instance.json` in the workspace are in
place (plan §8, §9); `EVOLUTION.md` and the briefing are not.

**Usage must tell us.** Whether inceptors migrate well from the log
alone, and whether the briefing message is read or ignored.
