# endograph

Embedded agents. An agent owns a bounded domain, holds a converged world
model of it, acts within a code-reviewed charter, answers its peers, and
escalates with context. It ships inside the system it tends — versioned with
it, constrained by it — rather than connecting from outside as SaaS. Built on
[projector](https://github.com/anteprojector/projector) (`@projectors/core`).

The CLI is `endo`; an agent is any directory containing `endograph.toml`.
The naming convention is `.{agentname}/`, but the directory may have any name.

Endograph is plumbing: how an agent is declared, how peers message it, how its
experience accumulates. What the agent *does* is prose in its charter. The
same runtime is a dev-stack supervisor, a build-and-deploy minder, or
whatever the next charter says.

## Shape

The deterministic core runs the boring 99% at zero token cost — the inbox,
playbook rules, health checks, restarts. The model is the judgment layer,
woken by requests and by drift no playbook rule covers:

```
sense (inbox, sensors) → diff → playbook match?
  yes → act deterministically
  no  → activate LLM → judge → act-under-charter → reply | escalate
→ record → settle
```

Everything that happens lands in a durable frame log (SQLite — query it with
`sqlite3`), and every thing the model works out once can be distilled into a
procedure or a deterministic rule so the next occurrence is instant and free.
Rules are strict by design: a rule whose script exits non-zero hands the
drift to the judgment layer with its output (`on_failure = "judge"`, the
default), so scripts handle the plain case and leave exceptions to the model;
exit 64 is a deterministic refusal and exit 75 hands the rest to a background
job. Rules written by another process — `endo capex`, your editor — apply live.

The model sees its whole history — every frame since the last **compaction**.
In a capex session the model summarizes what came before and calls `compact`;
the machine is rebuilt with that summary as its first frame. The store keeps
every frame forever; only the model's view is bounded.

## An agent is a directory

```
.minder/
  endograph.toml # the GRANT   — budget, schedule, model, tool grant (owner-only)
  charter.md    # the MANDATE — mission, norms, escalation policy (owner-only)
  agent.db      # frame log + world model (SQLite)
  inbox/        # requests from peers, one file each, consumed on arrival
  src/          # the EXPERIENCE — agent-writable, starts empty
    playbook/   #   procedures (named scripts) + learned rules
    sandbox/    #   scratch: prototypes, drafts, proposals
```

Commit `endograph.toml` and `charter.md` with the project — they are the
reviewed mandate. Ignore `agent.db`, `inbox/`, `src/`, and `env` (an
optional KEY=VALUE file for the model's credentials) — they are the agent's
lived experience and its keys. `rm -rf` the ignored parts to factory-reset.

## Message passing

Formal transport, prose content. A request carries exactly three structured
things — who sent it, a correlation id, and one optional `ref` (a sha, a
path) — and a free-text body. The reply is `ok` plus prose.

```
endo --agent ~/dev/app/.minder send --wait "deploy this worktree to stout"
# → inc-4f2a91c0, then blocks until the agent replies (exit 0 ok / 1 not ok / 2 timeout)
endo --agent … wait inc-4f2a91c0     # or fire-and-forget, then wait later
endo --agent … reply inc-4f2a91c0 "deployed 7f341 to stout"     # a job or peer answering for the agent
endo --agent … world set target:stout --state yellow "building since 09:41"   # keep `status` truthful
```

The inbox is the channel for every non-model actor — peers, the owner, and
the agent's own background jobs: requests, replies on the agent's behalf,
and world-model updates all ride it. A rule script that starts long work
exits 75 ("in progress"): the request stays open, the loop moves on, and
whoever finishes the work answers with `endo reply`.

`send` drops a file in `inbox/`; the running agent's inbox sensor drains a
poll's worth of requests into one drift, so a burst of requests is judged
once (debouncing and conflict resolution are then the charter's business).
Every request is answered exactly once: the model calls `reply`, and
anything it leaves unanswered gets the drift's settlement automatically.
`endo status` lists requests still awaiting a reply.

## Charter-only agents

```
endo learn      # agent reads its charter, explores the project, writes procedures
endo up         # run in this terminal: watch the inbox, judge requests and drift, supervise
endo install    # or run it as a launchd user agent: now and at every login (restart / uninstall)
endo capex      # on demand: distill recent experience into rules (zero-token next time)
endo status     # one status surface — world model, open requests, recent frames
endo why stout  # recent frames about a subject
endo replay inc-1a2b3c4d
endo digest     # today's account: requests, rules, judgment, spend
endo reset --force
```

The judgment layer's tools: `bash` under the granted shell, `run_procedure`
(a named script from the playbook, args as `ENDO_ARG_*`), `world` (maintain
the world model), `reply`, `write_playbook_entry` (validated, `sh -n` on the
script, recorded as a `playbook` frame so the owner can see the agent change
its own rules), `try_rule` (dry-run a rule against a synthetic drift),
`compact`, and the two terminals `resolve` / `escalate`.

The charter, the grant, and the playbook all reload while the agent runs —
edit them, or let the agent edit its playbook; only new endograph code needs
`endo restart`. When the playbook holds a `bring-up.md` with
`[[process]]` tables, the dev-supervisor adapter is mounted as well: the
agent starts those processes in dependency order with real readiness probes,
gets a `process` tool, and restarts on exit by rule.

The install doc is a prompt: point your coding agent at
`skills/endo-init/SKILL.md` ("create a endo agent for this project") and it
writes the grant and the charter, then `endo learn` lets the agent discover
what it needs.

## The judgment layer

Requests, and drift no rule covers, activate the model. `endograph.toml` names
the provider (`anthropic` or `openai`) and model; credentials come from the
environment or the git-ignored agent `env` file. The executor is
projector's `@projectors/aisdk-executor` over the AI SDK, so any provider
the AI SDK speaks is one line away. The activation is a projector machine
activation: the charter is the system mandate, the world model is projected
into context, and every tool call lands in the frame log with full
attribution. Observed log text enters context explicitly marked as
untrusted evidence; peers' requests are instructions weighed against the
charter. Activations close with `resolve` or `escalate`, are rate-limited per
drift class, and a judge failure (no credentials, API down) records an
escalation and never stops the agent.

## The economy

Budgets are soft: the runtime meters, projects, and warns — it never
enforces (hard stop-loss belongs to the platform: API spend caps). The
primary currency is dollars. `endograph.toml` grants a daily allowance split
into two envelopes, and every activation is metered against one by its
reason:

- **opex** — run the system: requests, drift diagnosis and repair, reporting.
- **capex** — build assets: `endo learn`, `endo capex`, and the lazy
  research session that runs after every N opex activations
  (`[schedule] capex_every`, default 5): compact if history is long, then
  turn recent incidents into rules. Paced by the workload, never the clock.

The balance is projected into the model's context on every activation, so a
warned model lands the plane; 75/90/95% thresholds record warnings in the
frame log and on the status surface. Each day rolls over into a
deterministic digest (`endo digest`).

## Develop

`@projectors/core` and `@projectors/aisdk-executor` are consumed as bun
links to the projector monorepo checkout (`~/dev/projector`): run
`bun link` in `packages/projector` and `packages/aisdk-executor` there
once, then here:

```
bun install
bun test
bunx tsc --noEmit
bun link          # puts `endo` on PATH (~/.bun/bin)
```
