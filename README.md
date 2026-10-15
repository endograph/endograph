# endograph

[Website](https://endograph.github.io/endograph/)

Endograph runs agents in your infrastructure, using
[projector](https://github.com/endograph/projector). You give an agent a
manifest describing its job and permissions for what it can access. A coding
agent writes its program. Once running, it receives messages and develops
its own tools and notes.

The v3 rewrite is in progress. `docs/rewrite-plan.md` describes the scope
and implementation order. `docs/program.md` defines the program contract
used during inception. Deferred ideas are in `docs/v3-future.md`.

## Create a development helper

With Bun and a signed-in Codex installed (the agent runs on Codex; setup and
inception can use Claude Code instead, see [Coding agents](#coding-agents)):

```sh
npx endograph@latest create endodev
# Or, with endo installed:
endo create endodev
```

Setup asks which repository or worktree to service and what you want Endodev to
take over. Enter accepts the current directory; the path prompt supports directory
completion and validates your selection inline. The initial description is optional: you
can point to a skill, script, or document, or explain what you want in the conversation. A native
Codex (or Claude Code) terminal session investigates the relevant repository context and asks up
to four focused questions, including testing responsibility (agnostic, own tests,
or custom) and worktree policy when your intent does not already establish them.
You can discuss the draft and request edits in the full native interface. When you
are satisfied, the coding agent runs the finish helper and exits automatically. Endograph
validates the draft manifest and config, bundles the Jev skill, installs pinned dependencies, and adds a
small section to the repository's `AGENTS.md`. Review the files before accepting
the offer to incept and start. Accepting reopens the setup conversation for interactive
inception, using the same staging, validation, and repair flow as `endo incept --interactive`.
After successful inception, the agent starts. Choosing to review first leaves the files
ready for `endo up --interactive --agent .endodev`; its first inception also reuses the
completed setup conversation. Later inceptions start their own conversation, and
interrupted inceptions resume their saved session. No agent program or procedures ship with the prefab.
The agent is unsandboxed and manages processes by default. Testing ownership and
other responsibilities come from the owner's selections.

Commit `.endodev/`, including its `package.json` and `bun.lock`. Its `.gitignore`
excludes `.endo/`, `node_modules/`, and `.env`. Each checkout has independent agent
state and a directory-scoped runtime name; `cwd = ".."` targets that checkout.
New worktrees inherit checked-in owner files and start explicitly:

```sh
npx endograph@latest up --agent .endodev
.endodev/node_modules/.bin/endo --agent .endodev status
.endodev/node_modules/.bin/endo --agent .endodev send --wait "Restart the dev server"
```

Startup installs missing dependencies from the lockfile and incepts fresh local
state. The launcher hands commands and service installation to the local pinned
Endograph package, so services do not depend on npm's execution cache. Re-running
`create` refuses to overwrite an existing agent. Resume the setup conversation:

```sh
endo setup --agent .endodev
# Or provide the revision as the initial prompt:
endo setup --agent .endodev "Keep tests agnostic and retain dev logs for seven days"
```

Drafts and the saved native session (harness and thread ID) live in `.endodev/.endo/local/setup/`.
Exiting the coding agent without finishing preserves the draft for this command to resume.
Later edits start from the current owner files and retain the same conversation.
An agent created by the earlier setup flow opens a new conversation around its
existing files. Transcripts remain in the harness's own local storage; other
machines and worktrees begin their own setup conversation.
Publishing edits changes the owner inputs: a running agent with automatic
inception observes them. If it is stopped, run `endo up --agent .endodev` when ready.

No autonomous dependency upgrades or automatic creation of worktree agents occur.
The "only this checkout" choice is an owner mandate, not a sandbox restriction.

## Agent files

```
project/agents/endofrog/
  endograph.toml      # owner grant, executor, batteries, host actions, sandbox policy
  manifest.md         # the owner's intent, in prose (or inline in the grant under [manifest])
  .env                # owner credentials, gitignored; loaded by the host
  host/               # optional owner-managed host action modules
  .endo/              # agent-managed state and local runtime files
    frames/           #   immutable frame commits and instance checkpoints
    agent.db          #   rebuildable indexes and transactional runtime inbox
    program/agent.ts  #   the program, written at inception
    src/              #   what the agent writes: procedures, notes
    inbox/  outbox/   #   the wire: one JSON file per message and reply
```

Run `endo up` in the agent directory. It registers the agent, installs
a launchd or systemd service, and starts it. If the agent has no program,
Endograph runs inception first: a headless coding agent
writes `program/agent.ts` from your manifest.

To collaborate with a coding agent during inception:

```sh
endo up --interactive --agent .endodev
# Or explicitly incept a stopped agent without starting it:
endo incept --interactive --agent .endodev
```

The coding agent opens in the staged inception candidate with the mandate, program contract,
capabilities, and existing agent state. Discuss changes and ask it to finish when
ready. Endograph validates the result and promotes it through the normal inception
path. Validation failures reopen the same conversation with `ERRORS.md` for repair.
You can explicitly ask it to revise the manifest or config during this conversation.
Those files are otherwise off limits. Requested edits stay staged until the program
passes validation against the final inputs; owner files and their matching inception
snapshot are published with the program. Headless inception cannot change owner inputs.
Exiting early preserves the candidate; rerun `endo incept --interactive` with the
same `--agent` to resume it. If owner inputs or live agent state have changed in
the meantime, the old draft is retained and a fresh candidate is prepared.

`up --interactive` incepts when no inception has been recorded, the program is
missing or invalid, owner inputs or the program changed, or an interactive attempt
is pending. Otherwise it starts normally.
The interactive choice applies to this invocation; background automatic inception
remains headless. Stop an already-running agent before interactive inception.
The flag requires a terminal and a coding agent, and cannot be combined with `--manual`,
`--accept`, `--inceptor`, or `--service`.

When the agent directory has a `package.json`, every `endo up` installs its
dependencies before loading host modules or the agent program. Bun lockfiles use
`bun install --frozen-lockfile`; npm lockfiles use `npm ci`. With no lockfile,
`bun install` creates one. Commit the lockfile. Installation failure stops
startup; dependencies are never upgraded on startup. Stop a running agent
before reinstalling its dependencies.

Put credentials in `.env` beside `endograph.toml` and add it to your
project's `.gitignore`. Existing process environment variables take
precedence over `.env`. If you're upgrading from the old layout, move
`.endo/env` to `.env`; Endograph no longer loads the old path.

Configure the agent through these owner files. You don't need to edit
anything inside `.endo/`. Endograph handles running the program and
delivering messages, and provides the program contract, procedures, and
optional capabilities called batteries. Inception determines how the agent
does its job.

## Coding agents

Setup, `endo setup`, and inception (interactive or headless) open a native coding
agent: Codex by default, or Claude Code when Codex is not installed. Choose one per
invocation with `--harness codex|claude`, or change the machine default:

```sh
endo harness           # show the default and what is installed
endo harness claude    # prefer Claude Code; Codex becomes the fallback
```

The default lives in `~/.endograph/config.json` and also selects the headless
inceptor for automatic inception (`codex exec …` or `claude -p
--dangerously-skip-permissions`) unless the grant sets `inception.inceptor`.
A saved conversation resumes only in the harness that stored it; without
`--harness`, Endograph reopens that harness when it is installed. Otherwise the
draft carries over into a fresh conversation. Claude Code asks once to trust each
new directory it opens. `endo create` and `endo up` in an empty directory also give
the new agent a runtime executor on the same harness (see below).

## Model access

New agents use a persistent native session for inference: Codex app-server threads
(`[executor] backend = "codex"`) or Claude Code conversations through the Claude Agent
SDK (`backend = "claude"`), matching the harness that created them. Install and sign in
to that coding agent as the service's user. The
[`@endograph/codex-executor`](packages/codex-executor/README.md) and
[`@endograph/claude-executor`](packages/claude-executor/README.md) READMEs
explain setup, session recovery, and how context carries across requests.
Explicit OpenAI API and custom executor configurations remain available for embedding.

## Snapshots and inspection

Run `endo snapshot <directory>` to save a restorable copy while the agent
runs. The [persistence docs](docs/persistence.md) explain what the snapshot
contains and how Endograph rebuilds SQLite. The
[sandboxing docs](docs/sandbox.md) cover process permissions and the
`hostAction` API for actions that run on the host.

`endo observatory` opens a live, read-only view on localhost. You can inspect
the Projector frame log, current machine state, and inception history. Each
inception record includes the changed inputs, the resulting program
structure, the coding agent's brief, and copies of the program and owner
files.

Use `--agent <name|dir>` to inspect an agent from another directory,
`--port <n>` to choose a port, or `--no-open` to leave the browser closed.
Bun bundles the React interface when the command starts. The first launch
installs a pinned React runtime under `~/.endograph/observatory/`, outside
the agent and its application.

## Develop

Read the [runtime architecture](docs/architecture.md) before changing the
code. It explains which components own each part of the runtime and how
message delivery, inception, and recovery work.

```sh
bun install --frozen-lockfile
bun test            # includes the end-to-end path: empty state dir → inception → a served request
bunx tsc --noEmit
bun link            # `endo` on PATH
```

The [testing docs](docs/testing.md) cover Linux sandbox CI and updating
the Projector dependencies.

`@endograph/server` provides an HTTP Fetch handler for each machine. It
authenticates callers and restricts reads to the intended recipient.
The [server docs](docs/server.md) explain setup, caller identity checks,
and notifications sent to specific recipients.
