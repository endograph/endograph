# Endograph v2 — rewrite plan

Status: agreed 2026-09-01 after one week of dogfooding endofrog
(`~/dev/froggy`). Companion docs: the original design record
(`~/sidecar/sematon/design.md`, incl. the use-case catalog) and the
2026-08-30 report (`docs/next-steps.html`). This document supersedes both
where they disagree. The v1 implementation is in git history (last commit
`4455c59`); v2 is a clean-slate rewrite focused on simplicity and
maintainability.

## 1. What endograph is

A host for long-lived embedded agents built on projector. In order of how
much of it is ours:

1. **A messaging protocol.** Request/reply between agents and every
   non-model actor. Formal transport, prose content. The only part that is
   not projector; specified as a document a peer in any language can
   implement against a directory (§7–§8).
2. **A filesystem convention.** An agent is a declaration directory
   (`endograph.ts` + `mandate.md`); its home is where it lives and runs (§2).
3. **A runtime.** The sense → rule → judge → settle loop, driving an
   activation to quiescence, settle-once, compaction, rehydration, the
   store. Projector lacks these for long-lived agents; endograph owns them
   and upstreams what generalizes.
4. **Idioms.** The playbook contract (exit codes, fall through to
   judgment), settle-once, the compaction session, metering by activation
   reason. Opex/capex vocabulary becomes a battery.
5. **Batteries.** Projector actions, states, and sensors that endograph
   exports and the owner registers in `endograph.ts` (§4).

## 2. Layout: declaration and home

The declaration is committed to the project. The home is where the agent
lives and runs; it links back to the declaration. The agent's identity is
its home's location on disk; being powered by endograph is secondary.

**The name is a required field of `defineAgent`**, enforced by the type
checker. There is no `--name` flag. A declaration is one directory holding
`endograph.ts` and `mandate.md`; several agents in one project are several
directories. Variants of one agent (staging, a second machine) are separate
declaration directories importing a shared module, not CLI overrides.

```
project-repo/agents/minder/     # DECLARATION, committed
  endograph.ts                  #   the GRANT and the BOUNDARY (defineAgent)
  mandate.md                    #   the MANDATE — mission, norms, escalation. Prose.

project-repo/agents/minder/.endo/minder/   # HOME, default: .endo/{name}/ beside the
                                           #   declaration (gitignored: `.endo/`);
~/.project-repo-minder/                    #   or anywhere via `endo up --home <dir>`
  declaration -> ../..            #   symlink to the declaration dir (relative in the
                                  #   default case, absolute otherwise)
  env                             #   optional KEY=VALUE credentials, host-local
  agent/                          #   the running state; `rm -rf agent/` = factory reset
    lock                          #     flock held while running; the kernel releases it on death
    agent.db                      #     frame log + world model (SQLite), runtime-owned
    inbox/                        #     messages in, one file each, consumed on arrival
    outbox/                       #     replies out, one file per incident (§7)
    src/                          #     the EXPERIENCE — agent-owned, starts empty

~/.endograph/                     # GLOBAL, per user (machine-wide variant for system installs)
  agents/minder -> ~/.project-repo-minder      # the registry: name → home (§10)
```

- `endo up [dir] [--home <dir>]`: dir is a declaration dir (cwd if
  omitted) or a home; never walks up. The name comes from the
  declaration; a home knows its declaration.
- **Homes are found by their `declaration` link, never by computing a
  path from the name.** `.endo/{name}/` is only where a new home is
  created. `up` on a declaration looks for an existing home whose link
  resolves to this directory (local `.endo/*`, then the registry).
  Invariant: one home per declaration per machine.
- The name is used for exactly three things: the registry key, the unit
  label, and `from` on outgoing messages.
- Claiming the name at `up`: if the registry entry for this name points
  at this home, fine. If it points at a home that still exists — running
  or stopped — refuse and print where it is; a worktree cannot steal a
  name from a stopped agent. Take over only when the registered path is
  gone. "Running" is the `agent/lock` flock.
- **Renaming** (`name` changed in `endograph.ts`): while running, the
  runtime records a note that a restart is needed and keeps its claim.
  On the next `up`/`up -d` the home is found through its link (experience
  kept), the new name is registered, any other registry entry pointing at
  this home is removed as the old name, and `up -d` replaces the unit
  whose arguments reference this home. The home directory keeps its old
  path (cosmetic; `doctor` mentions it, `--home` moves it deliberately).
  Peers using the old name get "unknown agent".
- One structure for every home: one code path. Peers address an agent by
  its home path or its registry name.
- The declaration is loaded through its resolved real path so
  `endograph.ts` finds the project's `node_modules`.
- A stale `declaration` link (repo moved, home elsewhere) never touches
  `agent/`; repair with `endo up <home> --declaration <new dir>`.
- Nothing inside the home stores its own absolute path.
- A worktree or fresh clone holds declarations, never a half-agent.
- Bare `endo` lists the registered agents on the machine.
- A status snapshot file for cross-user readers is deferred until a
  shared host needs it; the outbox alone serves `wait`.
- Renames from v1: `endograph.toml` → `endograph.ts`, `charter.md` →
  `mandate.md`. "Charter" now means only the projector charter.
  `src/sandbox/` and `src/playbook/` are gone as special directories.

**Write rule: the agent writes `agent/src`, nothing else.** A norm under
full bash; enforced under the scoped shell. Project paths an agent must
write (a requester's build dir) are granted explicitly in the sandbox
battery.

**Permissions are host provisioning, not framework.** The runtime creates
directories once and never resets modes; writes outbox files
group-readable; tolerates inbox files owned by other users. Which users may
write the inbox or read the outbox is set where the service user is created
(cloud-init, Terraform, a Dockerfile, chmod). `endo doctor` reports the
effective answer.

## 3. endograph.ts and defineAgent

```ts
import { defineAgent, aisdk, budget, sandboxBash, inbox, playbook } from "endograph";

export default defineAgent({
  name: "endofrog",                       // required; the registry key
  mandate: "./mandate.md",
  executor: aisdk({ provider: "anthropic", model: "claude-opus-5" }),
  batteries: [
    sandboxBash({ network: "loopback" }),
    inbox(),
    playbook(),
    budget({ daily_usd: 5, envelopes: { opex: 0.8, capex: 0.2 }, capex_every: 5 }),
  ],
});
```

- `defineAgent`, not a second `createCharter`: the value is the whole
  agent. It expands each battery's states and actions into a real projector
  charter via projector's `createCharter` and carries the runtime-facing
  halves (sensors, hooks, schedules, commands) alongside. `.charter` is
  exactly what projector produced; extra `nodes`/`tools`/`states` pass
  through untouched.
- Endograph re-exports every projector primitive users need. A declaration
  never imports `@projectors/core` directly (version skew across links
  yields two copies of projector).
- `mandate.md` reloads live; `endograph.ts` changes need `endo up -d` again.
- Rationale: v1's `tools.grant` enum was parsed and never read; the
  projector charter was hardcoded. Requiring the boundary as typechecked
  code makes "code-reviewed charter" literal.

## 4. Batteries and extension points

Projector covers: states projected into context, actions, history
projections. The runtime exposes:

| Extension point | Used by |
|---|---|
| sensors (poll → drift) | inbox, later playbook sensors |
| hook: after activation (with execution report) | budget metering + warnings |
| hook: on settle, on frame, on day rollover | digest, rule statistics |
| scheduled activations (prompt, reason, trigger) | capex session |
| status lines | `endo status` |
| CLI commands | `endo digest`, `endo capex` |

A battery is one value bundling any subset, constructed at module load and
bound once the store/inbox exist (`bind(ctx)`; v1's `JudgeRuntime`, made
uniform). Fixed, not extensible: loop order, store seam, frame envelope,
settle-once, the inbox protocol.

**Budget battery** = projected state + after-activation hook (meter by
reason, 75/90/95% warnings) + capex schedule + day-rollover hook (digest)
+ `endo digest`/`endo capex`. Soft: meter, project, warn, never enforce.
Metering by principal (§9) is a digest line.

**Verbs and Adapter are removed.** A rule that names an action calls a
registered projector action; the loop records the invocation frame.
**Process supervision is cut** (readiness probes, ordering, backoff, the
bring-up format, the process tool): endofrog, the validated dogfood, is
charter-only. When a dev-supervisor agent is declared it arrives as a
battery on these extension points.

### The bash battery and sandbox notches

Notches: full bash → loopback only → allowlisted hosts → offline. "No
network" alone is rarely the useful notch (endofrog needs ssh; a dev
supervisor needs localhost). The sandbox wraps the model's bash and every
playbook script; the model API call stays outside.

Measured on macOS Seatbelt (`sandbox-exec`), 2026-09-01:

| Profile | internet | DNS | localhost TCP | ssh | fs r/w | bun/git/sqlite/pgrep |
|---|---|---|---|---|---|---|
| allow default, deny network | blocked | blocked | blocked | blocked | ok | ok |
| loopback only + mDNSResponder socket | blocked | ok | ok | blocked | ok | ok |

Findings: a naive `(local ip "localhost:*")` rule leaked all outbound —
profiles must be tested, never hand-written per agent. Sandboxes do not
nest (the service must run unsandboxed). `ps` failed to exec under the
offline profile. Linux: bubblewrap with an unshared net namespace. Plan:
adopt `@anthropic-ai/sandbox-runtime` (0.0.75; Seatbelt + bubblewrap +
allowlist proxy), pinned.

## 5. Executors

A slot on `defineAgent`, defaulting to the AI SDK executor, accepting any
`ProjectorExecutor`. The "model access" part of the grant.

Batteries are executor-agnostic: every run returns projector's
`ExecutionReport` (latency, usage, model), folded into frame provenance
and summed across steps by the activation driver. Pricing: executor-
reported cost → model-keyed table → grant `price` override → flagged
estimate. No usage → count activations only. Per-executor tuning goes in
projector's node-level `executorConfig`.

The drive-to-quiescence loop is the one executor-shaped piece of the
runtime; upstream it to projector.

## 6. The playbook

The set of entries the runtime discovers by frontmatter anywhere under
`src`. The src path is exported into every script's environment so entries
can source shared helpers.

Entry kinds: `rule` (drift glob, subject glob, regex, cooldown, failure
policy, script), `procedure` (description, typed args, expose flag,
script), later `sensor`. Markdown, `+++` TOML frontmatter, script in the
first fenced block, prose body for the next reader.

Exit-code contract (`sysexits.h`; `man sysexits`):

| Code | sysexits | endograph |
|---|---|---|
| 0 | EX_OK | handled; stdout is the reply |
| 75 | EX_TEMPFAIL | in progress; stays open for a later `endo reply` |
| 77 | EX_NOPERM | deterministic refusal (v1 used 64 EX_USAGE, a poor fit) |
| other | | failure; falls to judgment when `on_failure = "judge"` (default), else settled as failure |

Typed args, validated before spawn, passed as `ENDO_ARG_*` env vars, never
interpolated into script text:

```toml
+++
kind = "procedure"
expose = true
description = "Report what is installed on stout and whether it is running"

[args.WORKTREE]
type = "path"          # string | int | number | bool | enum | path | json
required = true
+++
```

The same schema drives `endo commands`, the zod schema of the model's
`run_procedure` tool, write-time validation, and the MCP tool schema (§8).
First milestone: `string` + `required` only; other types when a procedure
needs one.

Model tools: `write_rule`, `write_procedure` (later `write_sensor`),
`try_rule`, `run_procedure`. Per-kind tools replace v1's
`write_playbook_entry`: the input schema *is* the frontmatter, the tool
renders the file, and shared machinery (render, `sh -n`, playbook frame,
reload) sits behind them. Bash writes to src still load; the mandate says
to prefer the tools.

## 7. Messaging protocol

Every message is one JSON file with a `v` field, written to a temp name
and renamed atomically. Types:

- **request**: sender, correlation id, optional ref, optional origin, prose
  body. The agent decides whether a rule or the model answers.
- **call**: same envelope + name of an exposed procedure + key-value args.
  The sender asks for the deterministic answer; the model is never woken.
  Unknown/unexposed name → deterministic error reply listing exposed
  procedures.
- **reply**: ok + prose, exactly one per request or call. Written to
  `outbox/<incident>.json` as well as the frame log, so readers need no
  SQLite. A reply may be `input-required` (a question back to the sender),
  which v1 lacked.
- **world**: world-model update.

`from` is stamped by the binding (§8), never trusted from the payload; what
the client asserts about itself (worktree path) is `origin`. Lifecycle
vocabulary borrowed from A2A so a binding is a shim later: submitted,
working (exit 75), input-required, completed (ok), failed, rejected
(exit 77), canceled.

Exposure (`expose = true`) is the trust ladder made concrete: judged prose
→ the agent promotes a pattern to an exposed procedure, reviewable in src,
with rule statistics and the regret signal applying. Exposed procedures
are not registered into the projector charter (owner-reviewed, fixed at
load); they stay in src and the runtime routes to them.

Compared to adopting a standard: the endo protocol is a mailbox, MCP is a
tool socket, A2A is a task API. The mailbox is the durable substrate
(requests wait while the agent sleeps; no port, no server, single-writer
log). Borrow A2A's vocabulary; expose MCP as a front door; defer A2A
bindings until cross-machine peers need discovery and auth beyond ssh.

## 8. Bindings

**File (local, base).** Deliver = write into `inbox/`; receive = read
`outbox/`. No authentication: directory permissions are the boundary.
Identity = the inbox file's owner (kernel-verified), stamped `local:<user>`
into `from` by the CLI; `from` is never trusted from the payload.

**SSH.** Remote CLI execution; no protocol work:
`endo --agent stout:~/.froggy-endofrog send …` expands to
`ssh stout 'endo --agent … send --from ssh:eleven@fox …'`. SSH supplies
auth, encryption, and a verifiable sender. `scp` into the inbox + poll the
outbox is the zero-dependency variant.

**MCP front door.** `endo mcp --agent <name>` (stdio): `ask` = request,
one typed tool per exposed procedure, `wait`, status as a resource. Claude
Code / Codex sessions — endofrog's actual consumers — call the agent
natively. Highest-value interop; a few hundred lines.

## 9. Auth — out of scope (future work: `@endograph/server`)

Local can do anything; the file binding's boundary is directory
permissions; SSH carries its own identity. Nothing else is built in this
pass. The core keeps only the seams a server needs later: outbox files and
`from` stamped by the binding.

Recorded for later, not designed further now: a per-machine HTTP relay
(`endo serve`) that writes inbox files and reads outboxes for every agent
on the host — never a listener per agent; principals as `scheme:name`
(`local:`, `ssh:`, `oidc:`, `mtls:`, `proxy:`, `token:`) stamped into
`from`; two rights, read and write (reply/world never remotable); TS
config with providers as functions (`githubAuth`, generic `oidc`, mTLS,
static tokens, trusted-proxy headers), shipped in a separate
`@endograph/server` package; anything beyond that (RBAC, approvals) is an
external control plane that mints or fronts OIDC tokens. The CI-in-a-VPC
reference path needs none of it: CI OIDC → IAM role → `ssm:SendCommand` on
one custom document → `endo call` on the host; SSM's user gets write on the
inbox and read on the outbox. Bearer tokens, if ever: TLS only, hashed at
rest, ≤90-day expiry, rotated with overlap.

## 10. Registry and identity

`~/.endograph/agents/<name>` is a symlink to the agent's home, claimed by
the agent whenever `up` runs (not only at install). System installs use a
machine-wide directory of the same shape.

- Data, not code: any endo binary (project-local via `bunx endo`, or
  global) reads and writes it. No global install required.
- Moves fix themselves on the next `up` from the new location; a stale
  link is a dangling symlink, visible to `ls -l` and `endo doctor`.
- Conflicts follow the rule in §2: an existing registered home, running
  or stopped, is never displaced; only a vanished one is.
- The name is the declaration's required `name`. No separate stable id
  until renaming hurts.
- A port is an address, not an identity: rejected (only exists while
  running, collides, squattable).

## 11. Running

```
endo up [dir] [--home <dir>]
                     # foreground. dir = a declaration dir (cwd if omitted) or a home; never
                     # walks up. --home picks where a new home is created (default .endo/{name}/)
endo up -d [dir]               # ensure the unit matches this home, register, start (= install/restart/repair)
endo up -d --system  # system unit with a service user; needs root
endo down            # stop foreground or service, remove the unit
```

Supervisors: launchd user agent on macOS (RunAtLoad, KeepAlive with
`SuccessfulExit=false`, 10 s throttle); systemd user unit on Linux
(`Restart=always`; install must enable lingering or refuse loudly) or a
system unit with `User=endo`; in containers `up` is the entrypoint and
`-d` is an error.

**Moves.** Measured: after `mv`, a running bun process keeps a cached
`process.cwd()`, `realpath(".")` fails, and every child spawn fails with
ENOENT (bun passes the stale cwd). A moved home therefore cannot run bash,
a rule, or a procedure. Behavior: detect (stat of own path fails while the
db handle works), log one line, exit 0; `SuccessfulExit=false` means the
supervisor does not crash-loop. `endo up [-d]` from the new location
repairs registry and unit. Every client command runs the cheap check on
resolve and prints a hint when a registered path is gone. Optional later:
record the home's inode at claim time so `doctor --fix` can find a renamed
home by identity.

**No library postinstall.** Bun skips dependency lifecycle scripts unless
trusted (`bun pm trust`); pnpm blocks them; an install is the wrong
trigger (moves don't install) and the wrong context (CI, clones,
worktrees — a heal from a worktree is the duplicate hazard). A project's
own `postinstall: endo doctor --fix` is fine and visible.

## 12. CLI surface

Consumer-facing (what gets pasted into other projects' AGENTS.md):

```
endo send [--ref r] [--wait] <text>
endo call <procedure> KEY=VAL ...
endo wait <incident>
endo commands
endo status | endo why <thing>
```

Owner-facing: `up`, `down`, `learn`, `capex`, `digest`, `replay`, `reset`,
`doctor`, `mcp`; `reply` and `world` for background jobs
answering on the agent's behalf. `--agent <name|path|host:path>`.

## 13. Carried over from v1

Inbox semantics (settle-once, batch per poll, 75 leaves open), playbook
file format (extended), store seam, compaction and rehydration, frame
envelope in `frame.metadata.endo`, the grant/mandate/experience split, the
launchd unit shape.

## 14. Removed

`endograph.toml` and `tools.grant`; `charter.md`; `Verb`, `Adapter`,
mounting by `bring-up.md`; the hardcoded single node; `src/sandbox/`;
`write_playbook_entry`; exit 64; `install`/`restart`/`uninstall` as
commands; parent-directory discovery; process supervision (`supervise/`,
`adapters/dev/`, bring-up procedures, the `process` tool); the HTTP relay
and auth (future `@endograph/server`).

## 15. Open questions

- A2A binding trigger: first cross-machine peer beyond ssh.
- Reviewability of self-modification: git trail vs approval step.
- What of the next-steps report changes shape under batteries: playbook
  sensors, jobs + `job.finished`, delegate, notifications.

## 16. Implementation notes (2026-09-01, first cut landed)

Deviations from the sections above, chosen while building:

- `defineAgent` collects states and tools; the projector charter object is
  built when the agent opens (`openWorld`), because it needs the mandate
  text and is rebuilt on mandate reload. The boundary is still exactly
  what the declaration registers.
- Core tools (world, compact, resolve, escalate) are always present;
  `defineAgent` binds them and every battery through one `bind(ctx)`.
- A `call` whose procedure fails replies `failed` deterministically; only
  rules fall through to judgment. Procedures have no `on_failure` yet.
- Battery hooks are `afterActivation`, `onSettle`, and `tick` (every
  minute); the capex schedule is the budget battery counting opex
  activations in `afterActivation` and calling `ctx.activate`. No
  separate schedule concept.
- CLI battery commands get a read-only `CommandContext` (home, store,
  playbook), not the running agent.
- Units run `endo up <home> --service`; without the flag a foreground `up`
  refuses while the service is loaded.
- A store append failure is fatal (exit 1): the log is the agent.
- Scripts keep state under `$ENDO_SRC/.state/` (dot-dirs are skipped by
  the playbook walker); `from` is the principal, `origin` the caller's cwd.
- (superseded) zod was pinned to projector's exact version until projector
  moved to Standard Schema; core now validates with a JSON Schema validator
  and has no zod at all. Projector schemas are validation-only: no
  defaults, transforms, or coercion (see CLAUDE.md).

Native-projector pass (2026-09-02):

- Procedures compile to projector actions on every playbook change: the
  model sees `deploy(WORKTREE)` as a typed tool; an exposed procedure is
  contributed with caller `any` so peers reach it as a command. A `call`
  is `executeCommand` on the machine — request and result are machine
  frames (typed `call` / `outcome`). `run_procedure` is gone. The charter
  rebuild happens only between activations.
- The world tool is a state-bound action (`patchState` / `replaceState`
  through `ctx.updateState`); inbox world messages patch too.
- The activation driver is `runMachine`; execution reports are summed from
  step-frame provenance; the terminal action's value is read from the
  action-result message.
- Frames carry `provenance.runner = { home, pid }`.
- `aisdk({ maxOutputTokens, temperature })` lands in the node's
  `executorConfig.aisdk`.
- World and budget states render as prose, not JSON.
- `world.drain()` folds queued frames with `runMachine({ scheduleWork:
  false })`: only `runMachine` consumes the machine's queue, so the driver
  drains before enqueueing its own frame (else a restart's replayed
  execution reports would be metered against the next activation) and the
  runtime drains every few seconds on the activation chain.

Core asks agreed with projector's owner (2026-09-02): a `horizon` message
type (history renders from the latest visible horizon; audience semantics
inherited; no summary concept in core) and Standard Schema at every schema
position (JSON Schema internally). Dropped: terminal values on the run
result (apps define their own result; the terminal-tagged action result is
enough) and a quiescence helper (`runMachine` is it).

Landed: projector `af496b4` (merged `9236bfb`) moves every schema position
to Standard Schema with JSON Schema internal (`src/schema.ts`:
`normalizeSchema`, `withJsonSchema`, `SchemaError`); zod is projector's
private hydration dependency, no longer a peer. Endograph unpinned zod and
typechecks at 4.5.4 against projector's 4.4.3. Also landed: projector
`21616ed` adds the horizon message, and `15b36ac` gives every completion
a `lastResult` pointer (a MessageRef to the step's last action result or
assistant message); endograph's driver reads its result through it instead
of scanning messages. Input rejections carry Standard Schema issues verbatim on the
result and on the durable result message (projector `94080bc`); the string
is their rendering. Endograph renders them for peers as
`PATH: message; …`. Endograph's
`compact()` now enqueues one frame — `{ type: "horizon" }` followed by the
model's summary as a user message — and the machine renders history from
it. The compaction sequence bookkeeping and the rebuild-from-compaction
path are gone; `historyLength()` counts frames since the latest horizon.

Evolution (2026-09-02):

- Evolution is declared, not injected: `defineAgent({ children:
  [evolvable()] })`. `children` are nodes instantiated under the owner's
  root generator (mandate, tools, states; registered, never transitioned);
  their inline actions are registered in the charter and may carry a
  bind hook (`BIND`) that `defineAgent` calls with the runtime. A declared
  child absent from a persisted instance is attached with a spawn frame.
  `evolvable()` is the agent's self, the component `endo-self`: standing
  notes and the registered tools it chooses to carry project upward into
  every activation. Leave it out and the agent cannot reshape itself (and
  is not told it can). The evolution tools live on the
  self and act on it: `transition` replaces it (notes + tool names; a
  state-bound tool brings its registered state along), `spawn` adds a
  child under it (a component that extends the self, or a helper generator
  with its own trigger: once / with-parent / after-parent), `cede` removes
  one. A node the agent builds can only reference registered actions —
  new behavior enters only through the playbook. Every reshaping is an
  `evolve` frame.
- Hydration recovery is app-owned. When the persisted instance no longer
  hydrates against the charter (a carried tool was deleted), or a replayed
  transition/spawn cannot apply, a migrator proposes a corrected instance
  and hydration is retried, up to 5 times; a success ends with a fresh
  snapshot so the failing frame is never replayed again. The default
  migrator is the model, run as a bootstrap activation on the same store
  (frames typed `migration`, usage in provenance), with a guardrail: a
  proposal may drop only what the error names. After 5 failures the agent
  writes `agent/needs-human` and exits cleanly; `endo doctor` reports it,
  `endo up` retries, `endo reset --force` wipes. Projector stays strict.
- Known gap: migration usage is in the log's provenance but not metered by
  the budget battery (it runs before batteries bind).

Typed world + triggers (2026-09-02):

- `defineAgent({ world })` takes any Standard Schema over an object (or a
  spec with `init`/`render`); the `world` tool is generated from it (`set`
  = the schema's properties, none required, additional keys as the schema
  allows; `clear` = keys to remove) and bound to the state, so a rejected
  write never lands. Inbox world messages are the same `set`/`clear` patch;
  `endo world set <key> [json|text]`, with `--state/--kind` building a
  generic-map entry. No schema = the generic subject → entry map.
- Activations carry a structured trigger — `{ kind: "drift", drift,
  incident }` or `{ kind: "session", session }` — and projector's
  completion reason. Batteries classify on the kind, never on a label:
  budget meters sessions as capex and drift as opex. Sessions are declared
  by batteries (`learn` by playbook, `capex` by budget) and run by
  `endo <session>` or `ctx.session(name)`.

Hardening pass (2026-09-02):

- A request batch's texts ride in the drift `detail`, so a rule's regex
  sees a batch as it sees one request. A batch is settled as one.
- Calls run one at a time. `from` is overridden to `local:uid:<n>` when
  the inbox file's owner is another uid (the kernel's word beats the
  payload); our own uid may claim any principal, as it could forge anyway.
- On start, requests and calls consumed before a restart but never
  answered get an honest `failed` reply; `stop` abandons an in-flight
  activation rather than waiting hours for it.
- Scripts lead their own process group; a timeout kills the tree.
- Replay walks the log in batches (the 1000-row read limit had truncated
  it) and skips rows that carry no projector frame.
- Executor frames are typed `tool` / `judgment` and shown live by `up`.
- Playbook reload errors are recorded once per distinct problem; `doctor`
  flags a service unit whose path no longer matches the home.

Label taxonomy pass (2026-09-02):

- An activation carries a typed trigger, not a reason string:
  `{ kind: "drift", drift, incident }` or `{ kind: "session", session }`.
  The activation frame's payload records it; `afterActivation` hooks get
  it on the outcome. Projector's completion reason is `completion`.
- Opex/capex left the core. The budget battery defines the split: opex is
  every drift-caused activation, capex is every session (self-initiated),
  whoever declared the session. No battery interprets another's labels;
  batteries share through frames and projected states only.
- Sessions are a battery extension point (`Battery.sessions`, name →
  description + prompt). The playbook battery declares `learn`, the budget
  battery declares `capex` and starts it through `ctx.session("capex")`.
  `RuntimeContext.activate` is gone; `ctx.session(name, ask)` is the one
  way a battery starts an activation. `defineAgent` rejects duplicate
  session names.
- `endo <session> [ask…]` dispatches through the declaration like battery
  commands; `learn` and `capex` are no longer CLI built-ins. A session
  request on the inbox (the `session` field) is started by the inbox
  battery and answered with the session's outcome; it never becomes a
  drift, so the judge no longer inspects request payloads.

## 17. Implementation order

1. Core: store, frame envelope, world, loop, activation driver
   (upstream quiescence to projector), compaction.
2. `defineAgent`, batteries (bash, inbox, playbook, budget), executor slot.
3. Playbook: entries by frontmatter, typed args, exposure, per-kind tools.
4. Protocol: outbox, call, input-required; file + ssh bindings; registry;
   `up`/`up -d`/`down`; `doctor`.
5. Endofrog re-declared on v2 (dogfood gate).
6. `endo mcp`; sandbox notches via sandbox-runtime.
7. Future work, not scheduled: `@endograph/server` (§9); process
   supervision battery; playbook sensors; A2A binding; poly-agents from
   one declaration (below); history projections for cost (projector's
   `createHistoryProjectionFunction` on the layout is the natural place
   to elide old tool output — the owner has other ideas here, so nothing
   is designed yet); named layout slots + computed parts for the rule and
   procedure lists (prompt hygiene, caching).

**Future: poly-agents from one declaration.** One `endograph.ts` may
later instantiate several agents by supplying a special dynamic token as
its `name` (imported from endograph, e.g. `name: dynamicName`). When the
CLI loads a declaration whose name is that token, it requires the name on
the command line (`endo up --name <n>`) and records it in the home; every
other rule in §2 and §10 (one home per declaration *per name*, lookup by
`declaration` link plus recorded name, registry claim, conflicts) applies
per instance. Until then, variants are separate declaration directories
importing a shared module.
