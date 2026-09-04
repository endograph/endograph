# Endograph v3 — future

Concepts we know we want and have thought about, held back from
`docs/rewrite-plan.md` until usage shows the details. Each entry says
what it is, why we want it, what we already know, and what usage has to
tell us before it is built. Nothing in the plan depends on anything here.
When an entry lands, it moves into the plan and out of this file.

## 1. Sandbox policy

**What.** A `sandbox` field in the grant, applied once to the agent
process and therefore to everything it spawns: bash, procedures, the
model call. Agent-authored JS runs in-process with no escape because
there is no outside to escape to.

```ts
sandbox: {                    // omitted = no sandbox at all
  network: ["stout"],         // "full" | "loopback" | "offline" | hosts; executor host always added
  write: ["../.."],           // beyond the state directory; omitted = unrestricted
  env: ["FROGGY_DEPLOY_KEY"], // what the process tree sees; omitted = everything
}
```

- `network`: the notches, loosest first: full → allowlist → loopback →
  offline. The executor's host is always added. Each dimension is
  independent, so `network: "full"` with a `write` list is valid.
- `write`: paths writable beyond the state directory. This is what turns
  the plan's write rule from convention into enforcement; paths a
  procedure must write (a requester's build dir) are granted here.
- `env`: the variables the tree sees beyond the default set, which is
  exactly `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, and `ENDO_*`.
  Credentials come from the state directory's `env` file or the service
  environment, filtered by this list; nothing passes unlisted.
- `endo up --no-sandbox` skips the wrapper for one run and says so in
  status.

**Why it matters.** An agent with deploy keys and a shell is the owner's
blast radius. Everything else in endograph assumes the agent can be
trusted with what it holds; the policy is what makes that assumption
cheap. This is the most important entry in this file, held back only
because it is orthogonal to the inception bet and the dogfood agent runs
on the owner's own machine today.

**Implementation, already decided.** `@anthropic-ai/sandbox-runtime`
(Seatbelt on macOS, bubblewrap on Linux, an allowlist proxy for hosts),
pinned. This is the shape it was built for: Claude Code itself runs
under it with its API host allowed. Sandboxes do not nest, so the agent
cannot tighten the policy for one tool, and `endo up` becomes two
processes: an outer shim that runs unsandboxed (applies the policy, runs
inception, which needs the inceptor's network and write access,
supervises the inner) and an inner that is the agent. Exit codes from
the inner tell the outer what to do: 0 stop, 78 (EX_CONFIG) incept me
and restart, 1 failure. The two processes exist whether or not a policy
is declared; the policy only decides what wraps the inner. Profiles are
tested, never hand-written per agent.

**Measured** on macOS Seatbelt (`sandbox-exec`), 2026-09-01:

| Profile | internet | DNS | localhost TCP | ssh | fs r/w | bun/git/sqlite/pgrep |
|---|---|---|---|---|---|---|
| allow default, deny network | blocked | blocked | blocked | blocked | ok | ok |
| loopback only + mDNSResponder socket | blocked | ok | ok | blocked | ok | ok |

Findings still true: a naive `(local ip "localhost:*")` rule leaked all
outbound; `ps` failed under the offline profile.

**Open.** Should the inceptor run under a (looser) policy of its own?
Today it would run unsandboxed with the owner's credentials, like any
coding agent the owner runs.

**Usage must tell us.** Which notch endofrog actually needs, and whether
the write list is per grant or per procedure.

## 2. Automatic re-inception

**What.** The harness noticing that the owner's inputs (manifest, grant,
endograph version) changed and running an inception without `endo
incept`.

**Why.** An owner edits the manifest and expects the agent to follow. A
new endograph version breaks the load pipeline and the agent should
recover without a human.

**Already designed.**

- *Triggers.* A load-pipeline failure while the owner's inputs differ
  from the latest snapshot (breaking: now, on `up` or the inner's exit
  78); the inputs differ and the pipeline passes (non-breaking: pending,
  shown in `endo status` with its age).
- *Catch, don't predict.* The load pipeline is the detector. A separate
  "is this breaking" check would reimplement its stages and drift from
  them.
- *Whose fault.* A load failure triggers inception only if the owner's
  inputs changed since the last snapshot. Otherwise the failure came
  from the agent: keep the previous charter, feed the error back as a
  frame, do not summon the inceptor. (With the program inception-owned
  and procedure failures non-fatal, this rule mostly collapses: a
  program that fails to load is always an owner or endograph change.)
- *Cadence.* Non-breaking runs when the inputs have been stable for
  `debounce`, the agent is idle, and `minInterval` has passed since the
  last inception. Grant fields: `inception: { attempts, debounce,
  minInterval }`, where `attempts` is fresh inceptor runs (new context)
  after `rounds` is exhausted.
- *Giving up.* `needs-human` written in the state directory with the
  last errors; `endo doctor` reports it, `endo up --service` exits 0 so
  the supervisor does not crash-loop, `endo incept` retries, `endo reset
  --force` wipes. A change to the owner's inputs clears it.

**Usage must tell us.** Whether non-breaking re-inception should run at
all without the owner asking. The cadence defaults were a guess. Revisit
after a month of endofrog on manual `endo incept`.

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

**What.** `activation: { attempts, timeout }` in `defineAgent`, bounding
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

The core keeps only the seams: outbox files and `from` stamped by the
binding.

- **SSH.** Remote CLI execution: `endo --agent stout:<path> send …`
  expands to `ssh stout 'endo --agent … send --from ssh:eleven@fox …'`.
  Scheme `ssh:<user>@<host>`.
- **MCP front door.** `endo mcp --agent <name>` (stdio): `ask` =
  request, one typed tool per exposed procedure, `wait`, status as a
  resource. The procedure arg schemas are already the MCP tool schemas.
- **HTTP relay.** `@endograph/server`, a per-machine relay writing inbox
  files and reading outboxes for every agent on the host; principals as
  `scheme:name`, two rights (read, write), providers as functions,
  separate package. Verify at the edge against the provider's secret,
  normalize to a request with the sender's identity in `from` and
  provider facts as data, route by a thread key into `ref`; never a
  listener per agent. Scheme `oidc:<issuer>#<subject>`.
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
without the inceptor having to guess which parts of the instance are
default and which are the agent's intent.

**Already designed.**

- *The baseline is reproducible.* The program function is pure, so
  re-invoking snapshot n−1's program against snapshot n−1's provisions
  yields exactly the instance the agent started with:
  `instance.initial.json` in the workspace beside `instance.json`.
- *Every self-modification is a frame with provenance.* `EVOLUTION.md`
  in the workspace lists each spawn, cede, transition, and state update
  since the last inception, with the activation that made it, that
  activation's trigger, and the reason the agent gave. Default versus
  intentional is never in doubt.
- *Mechanical replay first.* Before the inceptor sees a conflict, the
  harness hydrates the new program's fresh instance and replays the
  evolution frames onto it. Spawns compose (they reference registered
  actions only), state updates patch unless the schema changed, cedes
  remove what they removed. Only two things fail: a frame naming an
  action or state the new grant dropped, and a transition, which
  replaces a node wholesale and would overwrite the new program's
  version of it. Those are the conflicts in `ERRORS.md`; the inceptor
  resolves them in `instance.json` and nothing else needs its
  attention.
- *Evolve actions take a required `reason`* that lands in the frame, so
  the evolution log reads as intent, not mechanics.
- *A briefing after re-inception.* Inception n ends by emitting a
  request to the agent, stamped `inceptor:<n>`, saying what changed and
  why, so the first activation on the new program is briefed rather
  than confused by tools and states that moved.
- *`docs/program.md` says why* to prefer spawn and state updates over
  transitioning the root: composable evolution survives re-inception
  unread.

**Usage must tell us.** Whether agents transition the root often enough
for the conflict path to matter, and whether the briefing message is
read or ignored. Lands with the evolve battery.

