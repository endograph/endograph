# @endograph/claude-executor

A Projector executor backed by **Claude Code through the Claude Agent SDK**, in
streaming-input mode over stdio. The Endograph host owns each Claude Code process,
authentication and persisted session IDs; the worker executes Projector actions
through the existing host connection. It speaks the same host RPC as
[`@endograph/codex-executor`](../codex-executor/README.md) and reuses its worker-side
executor and context policy.

Select it in an agent's `endograph.toml`, then restart with `endo up`:

```toml
[executor]
backend = "claude"
# model = "claude-sonnet-5"  # optional; otherwise Claude Code's default model
# effort = "high"            # low | medium | high | xhigh | max
# command = "/absolute/path/to/claude"  # executable; defaults to the SDK's bundled Claude Code
# max_tool_calls = 40        # per activation, including action discovery
```

`endo create --harness claude` writes this backend for new agents. Sign in to Claude
Code (`claude`, then `/login`) as the service's OS user first. The host uses that
user's Claude Code authentication: a Claude subscription login, or an API key in the
host environment. Credentials stay outside the worker. Tested with Agent SDK and
Claude Code 0.3.280 / 2.1.280; the SDK version is pinned because it ships the
matching Claude Code binary.

Switching an existing agent between `codex` and `claude` keeps Projector's durable
program, state and frames. Native sessions do not transfer: the first activation
on the new backend starts a conversation seeded from Projector's IR.

## Differences from Codex

- **One process per conversation.** `codex app-server` hosts many threads in one
  process; each Projector generator here has its own Claude Code process, started
  on first use and kept for later activations.
- **Tools.** The two fixed tools are an in-process MCP server (`endograph`), so
  Claude sees `mcp__endograph__list_actions` and `mcp__endograph__call`. A tool
  handler is an awaited function, so a result held until Projector commits is a
  pending promise rather than a deferred JSON-RPC response.
- **Structured output** is per conversation in Claude Code. A generator whose
  output schema changes reopens its conversation (resuming it) with the new format.
- **Effort** accepts `low` through `max`; Codex's `none`, `minimal` and `ultra`
  do not exist here.
- **Session identity.** Endograph assigns each conversation's UUID
  (`--session-id`) and resumes it with `--resume`. Transcripts live in Claude Code's
  own storage (`~/.claude/projects/`), keyed by the stable working directory
  `.endo/local/executors/claude/cwd`.

## Context policy

The same as Codex: first use sends the standing context, visible history and action
catalog; later turns append changed context and unseen history. A turn's input is
capped at 400,000 characters, well inside a 200k-token context window, keeping
instructions, state and actions intact and a contiguous suffix of recent history.
Claude Code compacts its own context window; its `SessionStart` hook (source `compact`)
then restores the current preamble, state and action catalog, which would otherwise
survive only in Claude Code's summary. Action results and context updates
arrive as MCP tool results; the host raises Claude Code's 25k-token tool-result cap
(`MAX_MCP_OUTPUT_TOKENS`) so they are never truncated or saved to a file the
conversation cannot read.
Projector `compact` summaries are appended and do not force native compaction.

## Lifecycle and recovery

`.endo/local/executors/claude/` holds atomic per-generator session associations and
context cursors. Before a turn the host persists an in-flight marker; the worker
acknowledges the context cursor, and the host also verifies the matching activation
completion in the recovered frame store. Without both, the next activation starts a
fresh conversation: native tool calls are never replayed. A saved conversation whose
transcript is missing also starts fresh, with the full context. A Claude Code process
that exits between activations is replaced, resuming its saved conversation. External effects
interrupted between execution and recording still have uncertain outcomes.

Claude Code runs with no built-in tools, no filesystem settings, hooks, plugins or
skills, no MCP servers except Endograph's, and no approval surface (anything that
would prompt is denied). A custom system prompt replaces Claude Code's. Agent effects
go through Endograph actions in the worker and its existing sandbox/host grants.
Owner-selected executable/model configuration is never accepted from worker requests.
When the host itself runs inside a Claude Code session, the enclosing session's
identity variables are removed so the agent's conversations are saved normally.

Run `bun test packages/claude-executor/test` for offline session, action and
recovery tests against a fake runtime; they need neither a login nor model inference.
