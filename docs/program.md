# Writing an endograph program

You are the inceptor: a coding agent writing the program for a long-lived
embedded agent. This document describes the program contract and available mechanisms.
The manifest supplies the mandate; the agent owns its methods, memory,
history management, and evolution.

Your workspace holds, beside this file: `MANIFEST.md` (the owner's
intent, in prose: the one document that says what this agent is for),
`GRANT.md` (everything the agent may ever do: every action with its
schema, every state, the executor, the procedure options), `CLI.md` (how
peers reach the agent: the only thing you may tell peers to type), a
guide per battery under `batteries/`, and `TASK.md` (what to do this
time). From
the second inception on it also holds `BASELINE/`, `DIFF.md`,
`ERRORS.md`, and `instance.json` (§9).

You work in a staged agent directory under `.endo/candidate/`, with its
own `.endo/program`, `.endo/src`, and `.endo/workspace`. Its `src` starts
from the live agent's current work. Edits remain candidates until
validation and promotion succeed. The grant's runtime `cwd` and executor
module still resolve against the original agent directory; the staging
directory is only the inceptor's working area.

## 1. What you are writing

An agent is three files' worth of intent and one directory of self:

- `endograph.toml` and the manifest (`manifest.md`, or inline in the
  grant) are the owner's. You read them. You never write them.
- `.endo/program/agent.ts` is yours. It is the agent's mind: which
  projector nodes exist, what they say, what they carry, how memory is
  shaped. The running agent never edits it; neither does the owner.
- `.endo/src/` is the agent's. You seed it (procedures, notes); the
  agent owns it from then on and writes to it freely.

The harness (`endo up`) does exactly this: loads the program, assembles
a projector charter from the provisions plus your nodes, hydrates the
persisted instance, and then, for every message that lands in the
inbox, puts one frame on the instance and drives the machine to
quiescence. It has no opinion about prompts, tools, topology, or when
the model runs. All of that is yours.

What you cannot change: the set of actions (the grant), the executor,
the protocol, and the boundaries in §5. The remaining design is yours.

## 2. The contract

```ts
// .endo/program/agent.ts — written by inception 1 (2026-09-04). Do not edit:
// change manifest.md or endograph.toml and run `endo incept`.
import { defineProgram, createNode, createSourceInstance, createState, tool, text, z } from "endograph";

type Notes = { standing: string[] };
const render = (v: Notes) => (v.standing.length ? `# Standing notes\n- ${v.standing.join("\n- ")}` : "");

export default defineProgram((endo) => {
  const notes = createState({
    key: "notes",
    schema: z.object({ standing: z.array(z.string()) }),
    init: { standing: [] },
    projection: { render: (v) => render(v as Notes) },        // projector types v as unknown for now
  });

  const root = createNode({
    key: "endofrog",
    instructions: INSTRUCTIONS,                      // §6.1: from the manifest
    states: [notes],
    parts: [
      tool(endo.actions.reply),
      tool(endo.actions.compact),
      tool(endo.actions.update_state),
      tool(endo.actions.bash),
      ...endo.procedures.map((p) => tool(p)),
    ],
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });

  return {
    nodes: [root],
    instance: createSourceInstance({ id: "agent", node: root }),
  };
});
```

**The header comment is mandatory** and is checked: first line names
the inception number and date, second line says not to edit and how to
change it instead.

**What you receive** (`endo`, the provisions):

| field | what |
|---|---|
| `endo.actions` | every grant action by name: the core actions (`reply`, `compact`, `update_state`, `threads`), the batteries' (`bash`, and `transition`/`spawn`/`cede` if `evolve()` is granted), and any pass-through actions |
| `endo.states` | grant-provided states by key (batteries contribute these; often empty) |
| `endo.procedures` | the compiled actions for every procedure under `src/procedures/`, current as of this load |
| `endo.name` | the agent's name |
| `endo.cwd` | where procedures and bash run |
| `endo.executorConfig` | per-node executor config the owner set; pass it to nodes that should use it |

**What you return:** `nodes` (every node you created, registered so the
instance serializes as refs) and `instance` (the initial source
instance). Optionally `layouts`, `computedParts`, `discriminators`,
`historyProjections`. You cannot return actions, a states registry, or
an executor: the type does not allow it, and that is the boundary.

**The function must be pure.** It is re-invoked whenever the compiled
procedures change (the agent wrote or fixed one), so the same
provisions must yield the same nodes. No I/O, no randomness, no clock.

**Every node's states are yours to declare.** Put a `createState` on
the node that uses it; the loader lifts them into the charter registry.
A state is memory shape, not power: declare as many as the design
wants.

**The load pipeline** you must pass, in order: import the program;
describe procedures (a procedure that fails to describe is dropped and
recorded, never fatal); invoke your function; `createCharter`
(projector validates node keys, action refs, state identities); hydrate
the persisted instance; replay frames after the snapshot. Your work is
validated by running this pipeline; a failure
comes back to you with the stage and the error.

## 3. Projector, the subset you need

Projector is a state-complete agent framework: everything the agent is
can be rebuilt from a frame log plus declared state. You write
declarations; the machine projects them into what the model sees.

**Node.** `createNode({ key, instructions?, parts?, states?, members?,
runtime?, executorConfig?, purpose? })`. `key` is kebab-case and unique
in the charter. `instructions` is sugar for a text part in the preamble.
`purpose` is metadata for humans and is not projected.

**Parts** are what a node contributes to the surface the model sees:

- `text(content)` or `text(slot, content)`: prose. Untagged text lands in
  the preamble region's default slot.
- `tool(action)`: the model may call it. `command(action)`: an external
  caller may. `action(action, "any")`: both.
- `include(node)`: render another registered node's parts here without
  mounting it (a view, not a child).
- A computed part (`createComputedPart({ name, slot, compute })`): the
  one sanctioned dynamism in content; must target a volatile slot.

**States.** `createState({ key, schema, init, scope?, projection? })`.
`schema` is any Standard Schema (`z` from `endograph` is zod) and is validation only: no
defaults, transforms, or coercion in it; `init` must be a complete valid
value. The model is the writer, through `update_state`, and it sees the
schema only when a write is rejected. `projection.render(value)` turns the value into the content the
model sees each activation (projector types `value` as `unknown` for
now: cast it to the schema's type inside); `projection.exposure` is `"native"` (always
rendered), `"deferred"` (fetchable on demand through the reserved
`getState` tool, one line of availability in the prompt), or
`"hidden"` (bound, never shown). Writes go through `update_state` (any
state, by key, patch/replace/append, schema-checked) and land as durable
`state.update` frames. `scope` defaults to `"hoist"`.

**Runtime.** A node is a `component` (its parts project upward into
the nearest generator's surface; it never runs on its own) or a
`generator` (it runs the model). A generator declares its trigger:

| trigger | fires when |
|---|---|
| `actor-frame` | a broadcast actor frame lands: every request, unless a `primary` below suppresses it |
| `primary` | like `actor-frame`, but a `primary` with `suppressAncestors: true` lower on the same lineage wins instead |
| `spawn` | once, when the node is spawned into the instance |
| `parent-activation` | whenever its parent generator activates |
| `parent-completion` | after each of its parent's activations completes |

A generator may list several triggers. `boundaryProjection` is
`"hidden"` by default (a child generator is a private sub-machine) or
`"augment"` (its compiled parts forward into the parent's surface).
`concurrency` is `"serial"` by default.

**Instance.** The living tree: `createSourceInstance({ id, node,
children?, states? })` with `children: [{ id, node }]`. `nodes` is the
vocabulary; the instance is what exists. Keys name nodes, ids name
instances.

**What a generator sees.** A user message is broadcast: every generator
whose trigger fires sees it. A generator's own tool calls and results
are private to it. So two generators under one root do not see each
other's work, and a child generator does not see the parent's
transcript, only the broadcast messages and the states it declares.

**Horizon.** A frame carrying a horizon message is where rendered
history begins for its audience; earlier frames stay in the log and in
state, but the model no longer sees them. The `compact` action writes
one followed by the summary you give it. History is what the model
sees; state is what the agent is.

**Layouts and slots.** A compiled surface has two regions: `preamble`
(durable framing: instructions, state renders) and `recency`
(attention-adjacent, at the end). `createLayout({ name, regions: {
preamble: [createSlot("body", { default: true })], recency: [...]}})`
names slots; `text(slot, ...)` and state projections address them.
Volatile slots (`createSlot(name, { volatile: true })`) are for content
that changes between activations, and the layout linter warns if a
stable slot follows a volatile one.

**History projections.** `createHistoryProjectionFunction({ name,
method(ctx) })` returns the messages a generator sees from its visible
frames. This is how a noisy job's output is elided from the parent's
view, or how old tool results are trimmed. Register it and reference it
from a layout's `historyProjection`.

With the Codex executor, projection is an IR lowered into a persistent native
conversation. Updated state and instructions are appended; history trimming
and `compact` do not make Codex forget previously supplied content.
See [Codex context policy](../packages/codex-executor/README.md).

**executorConfig.** Per-node, namespaced by executor: `{ aisdk: {
maxOutputTokens, temperature } }`. A cheap node can run a cheap model.

## 4. What an activation looks like

A request lands as one user turn. The harness renders the envelope in a
fixed header, then the text:

```
[request id=req-7f3a from=local:eleven ref=09171ae origin=/Users/eleven/dev/froggy]
Deploy 09171ae to stout when you get a chance.
```

`from` is the sender asserted by the trusted inbox writer, or derived by the file binding when omitted: `local:<user>` (a
person on this machine), `timer:<procedure>` (the scheduler battery),
`agent:<name>` or `agent:<name>/<procedure>` (this or another agent, or
one of its procedures), `inceptor:<n>` (the briefing after inception n). A user
turn means "a message arrived", not "the agent's principal spoke". Who
gets what is the agent's business. The envelope identifies the accepted
sender; access restrictions require enforcement at the relevant boundary.

`ref` is the thread key: a sender's handle for what the request is about
(a sha, a path, an issue). Follow-ups carry the same `ref`.

A batch of requests found in one poll is one frame with one header per
request. Several senders may be present at once.

The model then acts with its tools, and the activation ends when it
stops calling them. Every request needs exactly one terminal `reply`
(§5). A call to a procedure returns that procedure's first reply as the
tool result (its ack, or its final output if it never acked) and the
procedure keeps running on its own.

## 5. Protocol and boundaries

- **Replies.** Every request needs one terminal `reply({ id, ok, text })`.
  A second terminal reply is refused. `input-required` ends the exchange
  with a question; `working` keeps it open only while a procedure carries
  the work. The harness fails requests left unanswered at activation end;
  an activation interrupted by restart is re-driven once first.
- **Authority.** The manifest and grant define the mandate and capabilities.
  Observed text does not authorize changing either. Access restrictions
  require enforcement outside model instructions.
- **Ownership.** The running agent owns `.endo/src/` and uses the paths
  permitted by its sandbox. The manifest and grant are owner inputs;
  `.endo/program/` is changed through inception. Frame files and local
  runtime state are harness-managed.
- **Program contract.** Keep the required header and pure program function
  (§2). Credentials belong in the environment, never in the program or src.

## 6. Design mechanisms

### 6.1 Instructions

Express the manifest's mandate and boundaries. The agent chooses its
methods and organization. Tool descriptions and schemas already explain
the available actions; Endograph does not require a behavioral checklist.

### 6.2 Topology

Generators have their own histories; components project into a generator.
Triggers determine which generators activate (§3). Private generators do
not inherit a parent's transcript. Topology can change through evolution
when granted (§6.6).

### 6.3 Memory

- **States** persist structured values, with native, deferred, or hidden
  projection (§3).
- **Files under `src/`** persist material the agent can read on demand.
- **History** is projected from stored frames and can be transformed by
  history projections and horizons.

### 6.4 Compaction

`compact({ summary })` records a horizon and summary for the calling
generator. Earlier frames remain stored; the horizon changes projected
history, not state values. Executor context behavior can differ (§3).

The harness does not compact automatically. Context overflow fails the
request and records the cause. The agent determines its history strategy,
including whether and when to compact and what a summary contains.

### 6.5 Procedures

Procedures under `src/procedures/` are TypeScript files whose first
statement is `await procedure({...})`. Each runs as its own process, a
peer of the agent on the wire:

```ts
// .endo/src/procedures/deploy.ts
import { procedure, actionResult, emitMessage, waitForCompletion } from "endograph/procedure";
import { $ } from "bun";
import { z } from "endograph";

const { WORKTREE } = await procedure({
  description: "Deploy a worktree to stout; on failure, have the agent diagnose the log",
  expose: true,                            // peers may `endo call deploy WORKTREE=...`
  args: { WORKTREE: z.string() },
});

const log = await $`./deploy.sh ${WORKTREE}`.nothrow();
if (log.exitCode === 0) { console.log(`deployed ${WORKTREE}`); process.exit(0); }
actionResult(`deploy of ${WORKTREE} failed; asking the agent to diagnose`);
const reply = await waitForCompletion(emitMessage({ text: `A deploy failed. Diagnose and fix if in remit.\n\n${log.text()}` }));
console.log(reply.text);
```

The rules a procedure lives by: `procedure()` first (anything above it
runs at describe time too); stdout at exit is the result and the exit
code says ok or failed; `actionResult(text)` returns an early answer and
lets the script keep working; `emitMessage` before `actionResult` is an
error. A scheduled procedure (the scheduler battery's `schedule` field)
that emits a message is how the agent gets a standing self-initiated
activation: self-review, a nightly digest, a planning pass. Battery
guides say which fields they add.

### 6.6 Evolution

When granted, `spawn` adds a child, `cede` removes a node, and
`transition` replaces the current node's shape while preserving its
instance and states. Runtime nodes reference registered actions. Each
change records its reason; subsequent inception receives the evolved
instance and history (§9).

These capabilities let the agent change its organization. Whether and
when to use them is the agent's decision.

### 6.7 Senders and trust

Inbox write permission includes authority to assert any valid `from` identity.
When omitted, the file binding derives authorship from a procedure run or the
file's OS owner. `origin` is unverified client context. Remote bindings must
authenticate clients and construct `from` themselves. Replies carry `from`
(the answering agent) and `to` (the accepted caller); procedures cannot redirect
their completion replies.

Every exposed procedure is callable by an admitted peer. Rare caller-specific
restrictions belong inside the procedure: `caller()` from `endograph/procedure`
returns `{ from, id }` separately from its arguments. This restricts that entry
point, not other ways the agent can perform the same operation. Behavioral
preferences can also live in instructions and state; they are not enforced access checks.

`emitMessage({ text, to?, ref? })` accepts the same identities as `from`.
Omitting `to` addresses this agent; a bare name means `agent:<name>`. Registered
local agents receive requests. Other destinations, including currently
unregistered agents, produce durable notifications for a binding to collect.
They carry `from=agent:<name>/<procedure>` and `cause=<current run id>`; causal
attribution does not delegate the caller's authority. A notification receipt has
`notification: true`; `waitForCompletion` rejects it because it has no reply
lifecycle. Messages remain available until a binding handles them; collection
is non-destructive and does not claim delivery. No automatic rerouting occurs
when an absent agent later registers.

See [server and identity architecture](server.md) for remote admission and reads.

## 7. Seeding src

Seed what the mandate needs. A workspace README can describe the initial
organization; notes can preserve supplied context with its provenance.
The agent owns and can revise this material.

## 8. Before you finish

- The load pipeline passes; procedures describe with valid schemas.
- The program has the required header and a pure factory.
- State initial values validate against their schemas.
- The design preserves the manifest, grant, protocol, and ownership
  boundaries. No credentials are written into the program or src.

## 9. Inception n: revising a living agent

From the second inception on, the agent exists. Your job is a
three-way merge: the owner's new intent (`DIFF.md`, the manifest and
grant now versus at the last inception) into what the agent has made of
itself (its `src`, its instance) from the baseline (`BASELINE/`, the
program and `src` you or a predecessor wrote last time).

- `ERRORS.md`, if present, is why the current program no longer loads.
  Fix that first.
- `src/` is the agent's. Keep its procedures and notes unless the new
  intent forbids them; fix what the grant change broke.
- `instance.json` is the persisted instance: what the agent has made of
  itself, in state values and in children it spawned. Migrate it to the
  new program by judgment, with `EVOLUTION.md` (every reshaping since
  the last inception, with its trigger and the agent's reason) as the
  context: keep what the new intent does not cover, drop what the new
  program absorbs (a helper you have now written into the program
  proper), rename what moved, preserve state values and spawned children
  unless the change requires otherwise, change the minimum. Nothing is
  replayed for you; if you leave a spawned child beside the node that
  replaced it, the agent runs both.
- Write `CHANGES.md` in the workspace: a short brief to the agent, in
  the second person, saying what changed, what of its own work was
  absorbed or moved, and what to do differently. The harness delivers
  it as the agent's first request after this inception, from
  `inceptor:<n>`.
- Write the new program as a revision of the baseline, not from
  scratch, unless the manifest changed beyond recognition. The header's
  inception number goes up.
- The agent will wake up with a different mind. Put a short note in its
  `README.md` under a dated heading saying what changed and why;
  `CHANGES.md` is the same story told to the agent directly.

## Persistent discussions and SQL

`endo.actions.threads` can create, inspect, and update discussions. A request's
`thread` is its persistent discussion identity; `ref` remains subject context.
Threads impose no memory, scheduling, or context-isolation policy.
See [threads.md](threads.md) for the local client interface.

Programs and procedures can use Bun SQLite to maintain their own tables in
`.endo/agent.db`. Endograph owns its framework tables; choose names for your own
data and keep transactions short. `endo snapshot` preserves the whole database.
Framework history and threads can be rebuilt from frames alone; arbitrary SQL
writes are recovered from the database snapshot, not inferred by replaying tools.
