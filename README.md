# endograph

Embedded agents on [projector](https://github.com/anteprojector/projector).
An agent owns a bounded domain, holds a converged world model of it, acts
within a reviewed mandate, answers its peers, and escalates with context. It
ships inside the system it tends — versioned with it, constrained by it.

Endograph is plumbing: how an agent is declared, how peers message it, how
its experience accumulates. What an agent *does* is prose in its mandate.

```
sense (inbox, sensors) → rule match?
  yes → run the script            (zero tokens)
  no  → activate the model → judge → act → reply | escalate
→ record every frame → settle exactly once
```

## An agent is a declaration; it lives in a home

```
project/agents/minder/
  endograph.ts        # committed: the declaration
  mandate.md          # committed: mission, norms, escalation — prose
  .endo/minder/       # gitignored home, created by `endo up`
    declaration -> ../..
    env               # optional KEY=VALUE credentials
    agent/            # agent.db (frame log), inbox/, outbox/, src/ (the agent's own writing)
```

```ts
// endograph.ts
import { aisdk, bash, budget, defineAgent, evolvable, inbox, playbook } from "endograph";

export default defineAgent({
  name: "minder",
  mandate: "./mandate.md",
  cwd: "../..",                                    // where scripts and bash run
  executor: aisdk({ provider: "anthropic", model: "claude-opus-5" }),
  batteries: [bash(), inbox(), playbook(), budget({ daily_usd: 5 })],
  children: [evolvable()],                        // the agent may reshape itself within its mandate
});
```

A battery contributes projector states and tools (the model's boundary) and
runtime pieces (sensors, hooks, commands). `bash`, `inbox`, `playbook`, and
`budget` ship in the box; a custom one is an object with the same fields.

## Talking to an agent

Every message is a JSON file dropped into the home's inbox; replies land in
the outbox. Any process that can write a file is a client. The CLI is the
convenience:

```sh
endo up                              # run here; endo up -d for launchd/systemd
endo --agent minder send --wait "deploy this worktree"   # prose: a rule or the model answers
endo --agent minder call check-stout --wait              # an exposed procedure: deterministic, zero tokens
endo --agent minder commands                             # what can be called
endo --agent minder status | why stout | replay inc-1a2b
```

`--agent` takes a registry name, a home, or a declaration directory. The
registry is `~/.endograph/agents/<name>`, claimed by the agent when it starts.

## The playbook

The agent writes its own experience under `agent/src`: markdown files with a
`+++` TOML frontmatter block and a shell script. A **rule** matches a drift
(kind glob, subject glob, regex over the text) and runs its script; a
**procedure** is a named script with typed args, and `expose = true` lets
peers call it. Exit 0 handled, 75 in progress (a job replies later with
`endo reply`), 77 refused, anything else fails and falls to judgment. The
model writes them with `write_rule` / `write_procedure` (validated, `sh -n`,
recorded as a `playbook` frame so the owner sees the agent change itself).

## Develop

```sh
bun install         # @projectors/core and the AI SDK executor are bun links to ~/dev/projector
bun test
bunx tsc --noEmit
bun link            # `endo` on PATH
```

Design and decisions: `docs/rewrite-plan.md`.
