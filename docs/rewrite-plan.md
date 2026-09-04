# Endograph v3 — rewrite plan

Status: agreed 2026-09-03 after two days of v2 (last v2 commit `34600c7`,
archaeology only; v1 is `4455c59`); built 2026-09-03 and 2026-09-04
through every step of §16, and endofrog runs on it under launchd. The
decisions made while building are folded into the sections below (the
commit log has the order); what the dogfood is still watching is at the
end of §16. This document supersedes the v2 plan where they disagree.
v3 is a clean-slate rewrite on main: about 500 lines of v2 were carried
across (§16), everything else was deleted first and recreated only when
a section below called for it, so no vestigial decision rode in by
accident.

Trimmed 2026-09-03 to the essentials. Concepts we know we want but are
waiting on usage to shape live in `docs/v3-future.md`; this plan refers
to it as "future". Nothing here depends on anything there.

The shift: v2 hard-coded how an agent works (a sense → rule → judge →
settle loop, a root generator plus a self component, sessions, drift).
v3 hard-codes only what an agent *is*: a grant it cannot mutate, a
program a coding agent wrote for it, a message protocol, and a frame log.
How the agent works is decided at inception, by a coding agent reading
the owner's manifest, and revised by the same process when the owner
asks for it.

## 1. What endograph is

In order of how much of it is ours:

1. **A messaging protocol.** Request, call, and reply between an agent
   and every non-model actor, with authorship stamped outside the payload
   by the binding (§11). Formal transport, prose content. The only part
   that is not projector; specified so a peer in any language can
   implement it against a directory.
2. **A program contract.** What inception must produce and how the
   harness loads it: a function of the provisions returning projector
   nodes and the initial instance (§5). This is the spec the inceptor
   reads; inception is exactly as good as it.
3. **A harness.** `endo up`: opens the store, holds the grant, assembles
   the projector charter from grant plus program, delivers messages,
   drives the machine to quiescence, sleeps (§6). It has no opinion
   about prompts, tools, topology, or when the model runs.
4. **Inception.** A coding agent (Claude Code or Codex) writes the
   program from the manifest, and rewrites it the same way when the
   owner runs `endo incept` (§9). Every inception after the first has a
   baseline to merge from.
5. **Procedures.** The one way new behavior enters at runtime:
   self-addressable TypeScript scripts under `src/procedures/`, exposed
   as the model's tools and peers' commands, with a lifecycle the harness
   runs outside the loop (§7).
6. **Batteries.** Guides for the inceptor plus grant contributions and
   procedure fields (§8). They constrain shape, never behavior.

Nothing in the harness names a use case. Nothing in the harness decides
what the model should think about.

## 2. Vocabulary

| Word | Meaning |
|---|---|
| **agent directory** | The directory `endo up` runs in. Holds the owner's two files and the state directory. Its path is the agent's identity. |
| **grant** | `endograph.toml`: name, manifest path, executor, batteries by name, inception options. Data, owner-written, validated at load, never reachable from the program. |
| **manifest** | The owner's intent, in prose: `manifest.md` beside the grant, or inline in it. Input to every inception. Never handed to the running agent. |
| **state directory** | `.endo/`: everything the agent is. The frame log, the program, `src`, the wire, snapshots. Gitignored. `rm -rf .endo` is a factory reset; the next `up` incepts a fresh agent from the owner's two files. Copy-safe, and may be mirrored to another machine; one host runs it (§12, `docs/persistence.md`). |
| **program** | `.endo/program/agent.ts`: what inception wrote. Nodes, instructions, projections. Written only by inception; the running agent and the owner never edit it. |
| **src** | `.endo/src/`: what the agent writes. Procedures, notes, whatever it keeps as files. Seeded by inception, owned by the agent. |
| **provisions** | What the program function receives: the grant's actions and states, the compiled procedures, name, cwd, executor config. The narrowed view; `endo` in the examples. |
| **charter** | Projector's registry. Assembled at load from the provisions and the program's nodes. Never a file. |
| **procedure** | A TypeScript script under `src/procedures/` whose first statement is `procedure({...})`. A tool to the model, a command to peers, a peer of the agent while it runs. |
| **inception** | A coding agent writing the program from the owner's inputs. The first one starts from nothing; every later one starts from the previous snapshot and the agent's current state. Numbered. |
| **inceptor** | The coding agent that runs an inception. |
| **snapshot** | A copy of the owner's inputs, the program, and `src` as they stood after an inception. The baseline the next inception diffs against. |

Retired words: mandate, home, declaration, playbook, drift, sensor, judge,
session, settle, evolvable, world (as a special state), migration (an
inception with a baseline), rule, match, policy (future).

## 3. Layout

```
project-repo/agents/endofrog/     # AGENT DIRECTORY (two files; usually committed; git never required)
  endograph.toml                  #   the GRANT
  manifest.md                     #   the MANIFEST
  .endo/                          #   STATE DIRECTORY (gitignored; everything the agent is)
    .gitignore                    #     what a copy of the directory leaves behind (node_modules, the WAL); written once
    env                           #     KEY=VALUE credentials (mode 600), loaded at start
    endo.log                      #     the service's stdout/stderr
    lock                          #     flock held while running
    status.json                   #     what `endo status` reads; the host that holds the directory (residence, §12)
    agent.db                      #     frame log + machine snapshot (SQLite)
    program/agent.ts              #     the PROGRAM: defineProgram((endo) => ...), inception-owned
    src/                          #     agent-owned: procedures/*.ts (§7), notes, anything
    inbox/  outbox/               #     the wire (§11)
    snapshots/<n>/                #     inputs + program + src copy after inception n
    inceptions/<n>/               #     how inception n went: the workspace as read, each round's output, writes, errors
    workspace/                    #     the inception in progress

~/.endograph/agents/endofrog -> project-repo/agents/endofrog     # the registry (§12)
```

- `endo up` runs in the agent directory. No walking up, no `dir` argument.
  Three ways in:
  - the directory holds `endograph.toml`: load it;
  - `endo up --template <dir>`: copy that directory's `endograph.toml` and
    `manifest.md` here (refused when either already exists), then load;
  - neither: interactive. Ask, one question at a time: name, executor,
    the manifest (a path or text typed in), batteries to include. Write
    both files, then load.
- No `.endo/program/agent.ts` → inception 1 (§9). Otherwise the load
  pipeline (§5), then run.
- Nothing inside the agent directory stores its own absolute path.
- The write rule: the agent writes the state directory and nothing else
  beyond `cwd` paths its procedures need. Convention until the sandbox
  lands (future); `program/` inside it is inception's alone (§9).
- Three owners, three places: the owner writes the two files, inception
  writes `program/`, the agent writes `src/`. Review of the program is
  reading it or `endo replay`, never editing it.

## 4. The grant: `endograph.toml`

```toml
name = "endofrog"                 # required; kebab-case; the registry key, the unit label, `from` on outgoing messages
manifest = "manifest.md"          # default; or inline, with no file: [manifest] text = """..."""
cwd = "."                         # where procedures and bash run; default
batteries = ["bash", "evolve"]    # by name: bash, evolve, scheduler

[executor]
provider = "openai"               # anthropic | openai, through the AI SDK; credentials from .endo/env
model = "gpt-5.6-luna"
# max_output_tokens = 16000
# temperature = 0.2
# or, the escape hatch: module = "./executor.ts", a TS module whose default export is an ExecutorSpec

[inception]
# inceptor = "claude -p --dangerously-skip-permissions"   # default: the first of claude, codex on PATH
rounds = 5                        # validation rounds before an inception gives up
```

- The grant is data. Everything in it is a name or a number (or the
  manifest's prose, inline), so nothing in the agent directory is code: an owner edits it by hand, a peer in
  any language can write one, `endo up --template` copies it, and
  `DIFF.md` diffs a config. (For v3's first two days it was
  `endograph.ts` with `defineAgent`, which bought a type-level name check
  and cost a resolver trick to load it, a generated tsconfig beside it,
  and a rule against relative imports. The same check runs at load.)
- Validated at load: a bad name, an unknown key, an unknown or repeated
  battery, a missing executor all fail `endo up` with the file and the
  reason.
- The grant is the whole universe: every action the model can ever call
  (core actions, battery actions). Procedures compose these and cannot
  widen them (§7). Custom batteries beyond the built-in three, and
  pass-through projector states and actions: future, as packages named
  in the grant.
- Battery actions are offered, not placed. `evolve` puts transition,
  spawn, and cede in the grant; whether a node carries them, which node,
  and with what instructions is the inceptor's choice, like any other
  grant action.
- Core actions endo always contributes: `reply` (answer a request:
  ok, text, lifecycle state), `compact` (record a horizon and the
  summary that follows it), `update_state` (write any program-declared
  state through projector's address-based write, schema-checked).
- Endograph re-exports every projector primitive a program needs, and
  `z` (zod) for schemas. A program never imports `@projectors/core` or
  zod directly (version skew across links yields two copies).
- The agent directory holds no `package.json` or `node_modules`. `endo
  up` links the endograph that is running into `.endo/node_modules/`,
  and writes `.endo/tsconfig.json`; the program and procedures resolve
  upward to the link, and an editor or `bunx tsc` in `.endo/` typechecks
  them.
- `endograph.toml` changes are owner inputs: they need `endo up` again
  and `endo incept` when the program should follow (§9). Nothing in the
  grant reloads live.

## 5. The program contract

```ts
// .endo/program/agent.ts — written by inception 3 (2026-09-04). Do not edit:
// change manifest.md or endograph.toml and run `endo incept`.
import { defineProgram, createNode, createSourceInstance, createState, tool } from "endograph";

export default defineProgram((endo) => {
  const notes = createState({ key: "notes", schema: ..., init: ..., projection: { render } });
  const root = createNode({
    key: "endofrog",
    instructions: "...",                                          // from the manifest
    states: [notes],
    parts: [tool(endo.actions.bash), tool(endo.actions.reply), ...endo.procedures.map(tool)],
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
  return {
    nodes: [root],
    instance: createSourceInstance({ id: "agent", node: root }),
    // optional, straight projector: layouts, computedParts, discriminators, historyProjections
  };
});
```

**What the program receives:** the provisions. `endo.actions` (by name),
`endo.states` (by key), `endo.procedures` (the compiled actions, current
as of this load), `endo.name`, `endo.cwd`, `endo.executorConfig`.

**What it returns.** Registered nodes and the initial source instance;
optionally layouts, computed parts, discriminators, history projections.
The return type has no actions, no states registry, no executor. That is
the boundary, enforced by the type, not by a validator.

**States.** A node declares its own states; the loader lifts every node's
states into the charter's registry so descriptors with render functions
serialize as refs. Writes go through `update_state` or any state-bound
grant action. A state is memory shape, not power.

**Why a function.** Nodes reference action objects, not names. The
program needs the grant's actions and the current procedure actions, and
both come from endo. The function is re-invoked whenever the compiled
procedures change; it must be pure.

**The load pipeline.** Every `up` and every procedure change runs it:

1. import `program/agent.ts`; warn if its hash differs from the last
   inception record (someone edited it by hand)
2. describe procedures (§7): import each in describe mode, collect
   metadata, run battery validators, compile to actions. A procedure that
   fails to describe is left out and recorded as a frame; it never fails
   the pipeline.
3. invoke the program function against the provisions
4. `createCharter` from the provisions + the program's fields
   (projector's own validation runs here)
5. hydrate the snapshot from the store
6. replay frames after the snapshot

A failure at stages 1 and 3–6 carries the stage name and the error text.
It means the owner's inputs or endograph moved under the program, or the
persisted instance no longer fits it: `endo up` prints it and exits 1
with the hint to run `endo incept`; `endo up --service` logs it and
exits 0 so the supervisor does not crash-loop; `endo doctor` reports it.

Stage 2 runs in a child process (`procedures/describer.ts`), one per
load: bun never re-evaluates a cached module, so an in-process re-import
of an unchanged script cannot throw its sentinel again, and a child also
keeps a script's top-level code out of the harness. The program is
imported by mtime; `endo up` warns when its hash differs from what the
last inception recorded (someone edited it by hand). Naming an action
the grant does not hold (`endo.actions.foo`) fails stage 3 with the
granted names.

**Runtime evolution is projector-native.** Transition, spawn, and cede on
the action context reshape the instance; the `evolve()` battery exposes
them as actions, and the inceptor decides where in the tree they sit and
what the instructions around them say. A node built at runtime
references only registered actions; new behavior enters only through
procedures. Every reshaping is a frame.

**What the contract does not say.** Topology (one generator, or a child
per request), when to compact, what to remember, how to route.
`docs/program.md`, the inception input, is the contract as the inceptor
reads it plus the idioms: the options and their trade-offs. Inception
chooses. That document is where the quality of every agent is decided;
it gets more review than any module.

## 6. The harness

The agent is one process: `endo up --service` (what the unit runs) or
`endo up --foreground`. It runs the load pipeline, then serves; `endo
up` runs inception first when there is no program (§13). (The sandbox,
when it comes, wraps this in an outer shim; future.)

**One wake reason: a message.** The process sleeps until an inbox file
lands (a poll every second, plus `fs.watch` on the inbox). The router:

- `call` → start the named exposed procedure (§7) as its own process;
  the call's id is the run's id; the first reply the run produces (the
  ack or the terminal one) answers the caller. The model is not involved
  unless the procedure emits a message. Unknown or unexposed name →
  deterministic error reply listing exposed procedures. Procedures run
  concurrently; only activations are one at a time.
- `request` → one frame on the source instance carrying the text as a
  user message, then `runMachine` to quiescence. The envelope (`from`,
  `origin`, `ref`, the id) is rendered inside the turn in a fixed format
  as well as riding in metadata, so the model always sees who sent what;
  a user turn means a message arrived, not that the agent's principal
  spoke. A batch of requests found in one poll is one frame.

Timers are not a wake reason: a scheduler is a battery that writes inbox
messages (§8). Nor is "the agent wants to think about something": that
is a procedure that emits a message to its own agent (§7), started by a
timer, a peer, the CLI, or the model itself. Because the procedure runs
outside the loop, its wait on the activation it caused never blocks
that activation: the model's tool call returns the ack, the activation
ends, the emitted message starts the next one, and the procedure's wait
resolves then. Self-review, planning, and v2's sessions are all
procedures that emit.

**Reply exactly once, resume before failing.** Protocol, not program:
one terminal reply per request, and the harness supplies it when the
program does not. A request still unanswered when its activation ends
(quiescence, a thrown executor error, or the timeout) is failed with a
reply that says which; a request the model answered `working` stays
open for the terminal reply. A second terminal reply is refused. On
restart the harness reads the log: a request whose frame still has
runnable work (an activation without a completion) is re-driven once,
recorded as a `redrive` frame; anything else still open is failed with
"restarted before answering". A running activation is aborted after two
hours through projector's work-abort message. (Owner-tunable attempts
and timeout: future.) Open requests and running procedures show in
`endo status` and `.endo/status.json`. Procedures are external: a
restart neither kills nor settles them; the harness adopts their exits
(§7). Reattaching a re-driven activation to a run it already started is
not done: a model tool call gets a fresh run id each time, so only peer
calls (whose id is the call's) are idempotent, through the inbox's
duplicate-id drop.

**Context overflow.** The executor reporting an overflowed context
settles the request `failed` with a frame naming the cause; the next
activation starts with that frame in view so the program can compact.
`docs/program.md` requires every program to carry a compaction routine.
The harness never compacts on its own.

**Compaction is the program's call.** `compact` is a core action; the
horizon is projector's message; history renders from the latest horizon.

**Live reload.** A change under `src/procedures/` (`fs.watch`, debounced)
reruns the pipeline between activations and swaps the charter, rebuilding
the machine from the store; running procedures finish on the code they
started with. A procedure that fails to describe is dropped from the
charter and fed back to the agent as an inert frame the next activation
sees (once per distinct error, across restarts). A pipeline failure on
reload keeps the previous charter and records an `error` frame.

**Fixed and not extensible:** the store seam, the frame envelope
(`frame.metadata.endo`, mirrored into columns), the lock (an exclusive
SQLite transaction), reply-once, the protocol. A store append failure is
fatal: the log is the agent.

## 7. Procedures

A procedure is a TypeScript script directly under `src/procedures/`. It
is a typed tool to the model, a command to peers (`expose`), and while
it runs it is a peer of its own agent on the wire: self-addressable.
Every procedure is one file; helpers and notes live anywhere else under
`src` and are never imported by the loader.

```ts
// .endo/src/procedures/deploy.ts
import { procedure, actionResult, emitMessage, waitForCompletion } from "endograph/procedure";
import { $ } from "bun";

const { WORKTREE } = await procedure({
  description: "Deploy a worktree to stout; on failure, have the agent diagnose the log",
  expose: true,
  args: { WORKTREE: v.string() },     // any Standard Schema per arg
});

const log = await $`./deploy.sh ${WORKTREE}`.nothrow();
if (log.exitCode === 0) { console.log(`deployed ${WORKTREE}`); process.exit(0); }
actionResult(`deploy of ${WORKTREE} failed; asking the agent to diagnose`);
const receipt = emitMessage({ text: `A deploy failed. Diagnose and fix if in remit.\n\n${log.text()}` });
const reply = await waitForCompletion(receipt);
console.log(reply.text);
```

**One call declares and validates.** At runtime `procedure()` validates
the call's args and returns them. At load the harness imports every file
under `src/procedures/` in describe mode (`ENDO_DESCRIBE=1`, in one child
process per load, §5), where `procedure()` throws a sentinel carrying the
metadata, so the harness collects descriptions, schemas, exposure, and
battery fields without any script doing work. The one rule for authors: `procedure()` first; anything
above it runs in describe mode too. The arg schemas are the tool schema,
the command schema, and `endo commands`. The return type of
`procedure()` is where a result schema can be threaded later.

**Two phases.** The sync phase ends when the script exits or calls
`actionResult(text)`; what ends it is the action result the caller
gets. Emitting a message before the sync phase has ended fails the run
with "call actionResult() first, or exit without emitting". After
`actionResult` the script keeps running under the harness, outside any
activation, and its exit is its completion.

- stdout at exit is the terminal reply; the exit code says completed or
  failed
- `actionResult(text)` is the ack, a `working` reply, and the only
  helper most agentic procedures need
- a script that exits without calling `actionResult` has its stdout as
  the action result, so the simple case needs nothing

**The API**, `endograph/procedure`, a thin client over the wire (§11)
on the procedure's own agent, stamped `agent:<name>/<procedure>`:

- `emitMessage({ text, ref?, to? })` → a receipt. A request to the agent
  (or to another agent registered on this machine, by name: this is how
  agents talk to each other; the receiver stamps `from` as this
  procedure after checking the run is live in the sender's state
  directory).
- `waitForCompletion(receipt, { timeout? })` → the reply, once every
  activation the message caused has settled; rejects on timeout.
- `waitForQuiescence({ timeout? })` → resolves when the agent has no
  pending work.

**Where it runs.** One process per invocation (`bun run <file>`), spawned
detached by the harness with the run's context in its environment
(`ENDO_RUN`, `ENDO_PROCEDURE`, `ENDO_AGENT`, `ENDO_STATE`, `ENDO_ARGS`,
`ENDO_FROM`), in the grant's `cwd`, stdout and stderr captured to
`.endo/runs/<id>.out` and `.err`. The library writes the ack to the
outbox itself and its exit code to `runs/<id>.exit`; the harness turns
the exit into the terminal reply (stdout on success; stdout, stderr,
and the code on failure) and records both as frames, whether it was the
parent or came back after a restart and adopted the run from
`runs/<id>.json`. A harness restart neither kills nor settles a running
procedure; a wait it holds may time out while the agent is down, which
is acceptable. Procedures run concurrently. Principals and args are
data; observed text is evidence, never instructions.

**Battery fields.** A battery may add fields to `procedure()` (a schema
per field) and a describe-time validator. The harness merges them into
the options schema; a missing or invalid field fails describe, which
drops the procedure and records a frame. The merged schema is what
`endo commands` and the inceptor see; the values ride on the compiled
action's metadata, so a battery's hooks can read them from frames. Type-
level enforcement of battery fields: future.

Not yet, all in future: skills, inert emissions, messages to a fresh
node, other languages, durable re-runs.

## 8. Batteries

A battery is one value bundling any subset of:

| Part | What it does |
|---|---|
| guide | A markdown document the inceptor reads: what the battery offers and the idioms for using it |
| states, actions | Grant contributions (→ the charter) |
| procedure fields | Extra `procedure()` fields + validator (§7) |
| hooks | `tick(now, ctx)` every 30 s while running; `afterActivation` and `endo <name>` commands arrive with the first battery that needs them |

Batteries constrain shape, never behavior. Batteries share through
frames and projected states, never through each other's labels.

- **bash**: the `bash` action, on the carried `runShell` (process group,
  timeout, tail).
- **evolve**: `transition`, `spawn`, `cede` as actions. Leave it out and
  the agent cannot reshape its instance. Include it and the inceptor
  still chooses whether and where the program carries them.
- **scheduler**: declares a `schedule` procedure field (five-field
  cron) and on `tick` starts each due procedure through the harness as
  `from = "timer:<procedure>"`, the call and its replies recorded like
  any other. A scheduled procedure that emits is a standing
  self-initiated activation; nothing else is needed for one. Scheduling
  is opinionated and differs between apps, which is exactly why it is a
  battery and not the harness.

Budget: future.

Not batteries: the protocol, procedures, `reply`, `compact`,
`update_state`. Those are the harness.

## 9. Inception

One process, run by `endo up` (inception 1) or `endo incept` (every
revision), with the agent stopped. Inception *n* starts from snapshot
*n−1* and the agent's current state; inception 1 starts from nothing.
Only the owner triggers an inception after the first (automatic
re-inception: future).

**Triggers.** No `program/agent.ts`; or `endo incept`. `endo status`
shows when the owner's inputs (manifest, grant, endograph version) differ
from the latest snapshot, so the owner knows an inception is due.

**The workspace**, `.endo/workspace/`:

- `MANIFEST.md`: a copy of the manifest
- `GRANT.md`: the provisions as text: every action with its JSON schema
  and description, every state, the executor, the merged procedure
  options
- `PROGRAM.md`: shipped with endograph (`docs/program.md`: the contract
  as the inceptor reads it, and the topology and memory idioms with
  their trade-offs)
- `CLI.md`: how peers reach the agent (§14)
- `batteries/<name>.md`: each battery's guide
- `TASK.md`: what to do, in these terms, and the rules to keep: the
  program contract, the procedure format, reply-once, the write rule,
  the header the program must carry
- from inception 2 on: `BASELINE/` (the last snapshot's program and
  `src`), `DIFF.md` (owner inputs then versus now), `ERRORS.md` (stage
  and error from the last load, if any), `instance.json` (the persisted
  instance, serialized; the inceptor migrates it by judgment, future
  §16), and `EVOLUTION.md` (every reshaping since the last inception,
  with its trigger and reason). The inceptor writes `CHANGES.md`, a
  brief to the agent; the harness delivers it as the first request on
  the new program, from `inceptor:<n>`.

The inceptor writes `program/agent.ts`, seeds or revises `src`, and,
when the instance no longer fits, edits `instance.json`. An inception
with a baseline is a three-way merge: the owner's new intent, into what
the agent has since made of itself, from the baseline. The agent's own
procedures and its instance are preserved unless the change requires
otherwise; `TASK.md` says so. Everything else is the inceptor's
judgment: topology, instructions, what to remember, which procedures to
seed, where the evolve actions sit.

**Running the inceptor.** Headless, with the agent directory as cwd and
the prompt "Read .endo/workspace/TASK.md and do exactly what it says" as
the command's last argument: `claude -p --dangerously-skip-permissions`
or `codex exec --dangerously-bypass-approvals-and-sandbox` (first found
on PATH, or the grant's `inception.inceptor`, or `--inceptor <command>`;
`-p` mode cannot approve anything, and the inceptor must write files and
run bun). Both run on an API key, so a service host without a login
works. No built-in inceptor. `endo incept --manual` renders the
workspace and stops, so the owner can run a coding agent in it
interactively and then `endo incept --accept`; inception 1 of endofrog
happened this way, inceptions 2 and 3 headless.

**Validation.** After each inceptor run: the header check, the load
pipeline without an executor against the edited program, `src`, and
`instance.json`, and every procedure describing (the dry `endo
commands`). A failure is written to `ERRORS.md` in the workspace and the
inceptor is run again, told to read it, up to `rounds` times. Then `endo incept` exits non-zero with the last
errors and leaves the workspace for inspection; the previous program
stays in place and the agent can be started again as it was.

**Record.** A success writes an `inception` frame (n, manifest hash,
grant hash, program hash, endograph version, inceptor command, rounds
used, elapsed ms), a fresh machine snapshot so a failing frame is never
replayed again, and `snapshots/<n>/` holding the inputs, the program,
and a copy of `src`. Every attempt, success or not, also leaves
`inceptions/<n>/`: `inception.json` (command, prompt, timing, outcome),
`workspace/` as the inceptor read it, and `rounds/<k>/` with the
inceptor's stdout and stderr, the program and `src` as that round left
them, `ERRORS.md` when validation failed, `CHANGES.md` and
`instance.json` when written, and `round.json` (timings, exit code, the
failing stage). The snapshot is the baseline the next inception starts
from; the record is the evidence for iterating on inception itself:
the prompt, the workspace, the validation messages. Attempting
inception n again clears it.

**Self-evolution is not inception.** The agent evolves through
transition, spawn, cede, and procedures. The manifest is the owner's
truth; the agent never edits or proposes changes to it. The program is
inception's truth; the agent never edits it either.

## 10. Authorship

`from` is the one field the transport owns (§11). It is stamped by the
binding as `scheme:id`, never trusted from the payload; what the client
asserts about itself (a worktree path) is `origin`. Schemes: `local:<user>`
(the inbox file's owner, kernel-verified; overridden to `local:uid:<n>`
when the file's uid is not ours), `timer:<name>`, `agent:<name>`,
`inceptor:<n>` (the harness's own briefing after an inception). The
file binding tells the agent's own processes apart from the user they
run as by what the harness handed them: a procedure's library writes the
run id the harness minted into the message (`run`), and the harness
resolves a live run to `agent:<name>/<procedure>`; a battery inside the
harness process names its scheme directly. Same-user processes are
trusted either way: the uid says which user, the run id which procedure.
More schemes arrive with their bindings (future). Endo validates nothing
about the author; it guarantees the field is outside the payload and set
by the transport. Whether the agent does permissions with it is the
agent's business, and `docs/program.md` says so.

## 11. Messaging protocol

Every message is one JSON file with a `v` field, written to a temp name
and renamed atomically into `inbox/`. Replies go to
`outbox/<id>.json` as well as the frame log, so readers need no
SQLite.

- **request**: `id`, `from`, optional `origin`, optional `ref`,
  `text`, `at`. Answered by the model.
- **call**: same envelope + `procedure` + `args` (validated against the
  procedure's schema). Answered by the procedure's replies: an optional
  `working` ack, then one terminal reply.
- **reply**: `id`, `ok`, `state`, `text`, `at`. Exactly one
  terminal reply per request or call. `state` borrows A2A's vocabulary:
  submitted, working (a procedure's ack), input-required (a question
  back to the sender), completed, failed, rejected, canceled.

The request id is minted by the client (`endo send --id <id>` to supply
one; otherwise random). The inbox drops a second message with an id it
has already seen, so a retried CI job cannot create two requests. `ref`
is the thread key: `docs/program.md` shows one child generator per `ref`
so follow-ups share a history.

**Binding.** File, the base and for now the only one: deliver = write
into `inbox/`, receive = read `outbox/`; directory permissions are the
boundary. The seams other bindings will use are the outbox files and
`from` stamped by the binding; the bindings themselves (SSH, MCP, the
HTTP relay, A2A) are future.

Removed from v2: the word incident (a request has an `id`), the
`session` field (sessions are gone), the `world` message (a procedure
emits instead), and the `reply` message kind (the background job
answering on the agent's behalf is now a procedure).

## 12. Registry and identity

`~/.endograph/agents/<name>` is a symlink to the agent directory, claimed
whenever `up` runs. Data, not code: any endo binary reads and writes it.

- One agent directory per name per machine. Claiming: if the entry points
  here, fine; if it points at a directory that still exists, refuse and
  print where it is (a worktree cannot steal a name from a stopped
  agent); take over only when the registered path is gone. "Running" is
  the lock.
- A stale entry (the target moved or renamed) is visible to `ls -l` and
  `endo doctor`; the next `up` from the new location claims it. Anything
  more: future.
- Bare `endo` lists the registered agents. A port is an address, not an
  identity.
- Residence. A state directory may be mirrored to another machine (a
  copy, a synced checkout; `docs/persistence.md`); exactly one host runs
  it. `status.json` carries that host and whether it released (`down`,
  Ctrl-C). `up` elsewhere refuses while it is held; `up --adopt` takes
  it and records a `residence` frame. A running agent whose
  `status.json` is replaced by a newer one from another host records the
  move and stops: under a last-writer-wins mirror a double run becomes a
  handoff.

## 13. Running

```
endo up                      # in the agent directory: register, install the unit, start; incepts first (foreground) when there is no program
endo up --foreground         # run in this terminal instead (debugging, tests); refuses while the service is loaded
endo up --template <dir>     # seed endograph.toml + manifest.md from <dir>, then as above; with neither and no template, endo asks
endo up --adopt              # run a state directory another host still holds (a copy, a synced mirror); the move is a frame
endo down                    # stop the service and remove the unit
endo logs [-f]               # the service log
endo incept                  # re-incept now, with the agent stopped; --manual / --accept
```

An agent is a daemon, so `up` means "running and kept running".
Supervisors: launchd user agent on macOS (RunAtLoad, KeepAlive with
`SuccessfulExit=false`, 10 s throttle); systemd user unit on Linux
(`Restart=on-failure`; enable lingering or refuse loudly). Both restart a
failure and leave a clean exit alone, which is what lets a service exit 0
instead of crash-looping (§5, §9). Units run `endo up --service` in the
agent directory. Credentials live in `.endo/env` (KEY=VALUE, mode 600),
loaded into the process environment at start, foreground or service, so
a unit never holds a secret. No library postinstall: bun skips lifecycle
scripts unless trusted, and an install is the wrong trigger. System units
and containers: future.

## 14. CLI surface

Consumer-facing (what gets pasted into other projects' AGENTS.md):

```
endo send [--id id] [--ref r] [--wait] <text>
endo call [--wait] <procedure> KEY=VAL ...   # first reply by default; --wait for the terminal one
endo wait <id>
endo commands
endo status | endo why <id>
```

Owner-facing: `up`, `down`, `logs`, `incept`, `charter` (print the
provisions as the inceptor sees them), `replay`, `why`, `reset`,
`doctor`, plus battery commands. `--agent <name|path>`. The consumer
half is documented once, in `src/cli/usage.ts`, and rendered into every
inception workspace as `CLI.md`: the only source of truth for what a
program may tell peers to type.

## 15. Removed from v2

The loop (drift, sensor, outcome, rule matching as a stage); the judge
(framing and drift prompts, core tools other than reply/compact/state);
sessions (`learn`, `capex`, the `session` message field); `evolvable()`
and the self component; the declaration's `children`; the world state and
`world` messages; battery sensors, `onSettle`, and sessions; the
in-process model migrator and the word migration; the declaration/home
split, `--home`, the `declaration` link, `.endo/<name>/`; `mandate.md`
and live mandate reload; `write_rule`/`write_procedure`/`try_rule` (the
agent writes files under `src`; `docs/program.md` says how); the `rule`
kind and its v3 successor `match`; TOML frontmatter, `runShell` as the
procedure runner, the exit-code contract (0/75/77), `ENDO_*` argument
variables; the `reply` message and `endo reply`; exit 64; the budget
battery (future).

## 16. Implementation order

Work happens on main. Step 2 deletes everything not in the carry list
before anything new is written; endofrog stays down until step 8.

Carried from v2, with the named cuts and nothing else:

| Module | Cut |
|---|---|
| `src/store/types.ts`, `src/store/sqlite.ts` | `queries.ts` (v2 reads in retired words) and `memory.ts` (a test-only backend) |
| `src/cli/service.ts` (units) | `up <home>` → `up --service` in the agent directory; the log at `.endo/endo.log` |
| `src/judge/executor.ts` → `src/grant/executor.ts` | `price` and `model` (budget; future) |
| `src/inbox/protocol.ts` → `src/protocol/wire.ts` | `session`, `world`, the `reply` message, `localPrincipal` (the binding stamps `from`, §10); `incident` → `id`; the full reply-state vocabulary (§11) |
| `src/playbook/run.ts` → `src/batteries/bash.ts` | everything but `runShell` (process group, timeout, tail); parse, match, and types are deleted |

Order:

1. Docs: this plan, `docs/v3-future.md`, `docs/program.md` (the contract
   and the idioms, as the inceptor reads them), and a CLAUDE.md that
   describes v3. `program.md` is an inception input and gets the most
   review; it comes before any code.
2. Delete `src/` and `test/` except the carry list; move the carried
   modules to their v3 names with their tests.
3. The grant (`defineAgent` then; `endograph.toml` since), core actions, the bash battery.
4. The program loader and the harness: pipeline, charter assembly, router,
   `runMachine` to quiescence, reply-once, live reload of procedures.
   Procedures: `endograph/procedure`, describe mode, the two phases,
   battery fields, the run supervisor.
5. Inception 1, by hand first: workspace rendering, `endo incept
   --manual` / `--accept`, validation. Endofrog's first program is
   written by running Claude Code in the workspace interactively; what
   `TASK.md` needs to say is learned here. Then the headless inceptor
   with `rounds`, and the inception frame and snapshot.
6. Inception n: the baseline, `DIFF.md`, `ERRORS.md`, `instance.json`
   in the workspace, the program hash check, the status line for
   inputs-changed.
7. CLI, registry, `--template`, interactive setup, `doctor`, `charter`,
   `replay`, `why`.
8. Endofrog on v3 in `~/dev/froggy/agents/endofrog` (dogfood gate; it
   runs as a launchd service from `endo up`).
9. Batteries: scheduler, evolve.

Built 2026-09-03 (steps 1–5) and 2026-09-04 (6, 7, 9); endofrog was
incepted three times (one by hand, two headless) and deploys through it
on 2026-09-04, which opens the gate. What the dogfood is watching:
whether the agent keeps its section of froggy's `AGENTS.md` current;
whether `TASK.md` says enough (its first gap, the consumer CLI, became
`CLI.md`); how the model fares with `update_state` against the schemas
an inceptor writes; and the first spawn, which makes the next inception
a migration the inceptor performs by hand (future §16).

## 17. Projector notes

Landed and relied on: Standard Schema at every schema position with JSON
Schema internal (`af496b4`; schemas are validation-only, no defaults or
transforms); the `horizon` message (`21616ed`); `lastResult` on every
completion (`15b36ac`); input rejections carrying Standard Schema issues
verbatim (`94080bc`); address-based state writes on the action context
(`updateStateAt`), which is what `update_state` uses.

Endo-side, not asks: lifting node states into the charter registry at
assembly; re-invoking the program function on procedure change.

One ask, found writing the first program: `StateProjection.render` is
typed `(value: unknown) => string`, so a program's render functions must
cast. `StateDescriptor<S>` should carry `render?: (value: S) => string`.
Until then `docs/program.md` shows the cast. The tool-set-by-expression
idea from the v2 plan is withdrawn: the program spreads `endo.procedures`
into a node's parts. Also relied on: `collectRunnableActivations` (what
a restart re-drives), the work-abort message (the activation timeout),
and action results carrying messages (`compact` emits its horizon and
summary from the action).

Bun facts the design bent around: `NODE_PATH` is ignored and a runtime
`Bun.plugin` does not intercept bare specifiers (hence the grant copy
under `.endo/`, §4); a module is never re-evaluated for a new query
string (hence describe in a child process, §5).
