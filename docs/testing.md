# Verification

Run `bun test` and `bun run typecheck` with Bun 1.3.10. The sandbox tests launch
real OS-confined child processes and descendants. They use local HTTP services
and fake credentials; no model API key is required.

## Publishing

All four packages share a release version. From the repository root:

```sh
bun run release:check   # preview current versions; changes nothing
bun run release         # publish current versions
bun run release patch   # bump all patch versions, then publish
bun run release minor   # bump all minor versions, resetting patch
bun run release major   # bump all major versions, resetting minor and patch
```

A bump updates all manifests and the lockfile, without creating a Git commit
or tag. It also updates the server's Endograph runtime dependency to the same
version. The root development override resolves that dependency to this checkout;
consumers install the published version. Publishing is sequential: `@endograph/codex-executor`, `@endograph/endodev`, `endograph`, then
`@endograph/server`.
If publishing fails, versions stay bumped. Retry with `bun run release`
without a bump argument; already-published versions are skipped. Publishing
requires npm authentication and access to the `endograph` organization.
The preview command accepts no bump argument.

## Linux CI

`.github/workflows/linux-sandbox.yml` runs the OS boundary and CLI host-action
tests in separate processes on an Ubuntu 22.04 VM. It installs `bubblewrap`,
`socat`, and `ripgrep`, and checks that user, PID, and network namespaces work
before starting tests. Missing enforcement fails the job. It does not use a
weaker container sandbox or disable host security settings.

The two `@projectors/*` dependencies track published `latest` in `package.json`.
Update both together as Projector releases, retaining `latest` for both manifest
entries, then typecheck and test before committing the updated `bun.lock`.

The lockfile records the tested versions: `latest` does not bypass it. Local
development and CI install those versions with `bun install --frozen-lockfile`;
no sibling Projector checkout or repository variable is required.

The runtime pins `@endograph/sandbox-runtime@0.0.75-endograph.2`, an Apache-2.0
[fork of upstream 0.0.75](https://github.com/endograph/sandbox-runtime/blob/endograph/ENDOGRAPH_FORK.md)
with the mount-order fix from [upstream PR #447](https://github.com/anthropics/sandbox-runtime/pull/447).
It restores read-only ancestors before writable children. It also preserves
usrmerge aliases such as `/bin -> usr/bin` and mounts canonical policy paths
so security-patched bubblewrap never needs to mount on those symlinks. Read
restrictions and network policy remain enforced. Upstream native helpers are retained byte for
byte after verifying the original package's pinned SHA-512 integrity. The fork
ships compiled code and helpers, so consumer installs need no dependency patches
or lifecycle scripts. Return to upstream after a published fix passes these tests.

On Linux, a denied file may be masked by a read-only `/dev/null` mount. Tests
assert that protected contents are unavailable, accepting either an access error
or an empty masked file. Read-denied directories are hidden by private tmpfs
mounts. Writes inside those masks may succeed, so the tests also check from the
host that protected files are unchanged and no new host files were created.

## Codex backend

`bun test packages/codex-executor/test test/codex-host.test.ts` checks session
reuse, recovery, tool validation, cancellation and the real stdio/host IPC path
using an offline app-server fixture. It needs neither Codex login nor model
inference. The native protocol setup was also smoke-tested with Codex 0.153.3
(`initialize` and `thread/start` with dynamic tools, no model turn). See
[the executor package](../packages/codex-executor/README.md) for configuration
and context semantics.

## Claude backend

`bun test packages/claude-executor/test` checks the same session reuse, recovery,
tool validation, parking, cancellation and terminal behavior against a fake runtime,
plus serialized parallel tool calls, output-schema changes, the tool-call limit, and
a missing transcript. It needs neither a Claude login nor model inference. The real
runtime was smoke-tested with Agent SDK 0.3.280 and `claude-sonnet-5`: an action call
through the MCP tool, a follow-up in the same live conversation, a host restart that
resumed it, and a missing transcript reported as a failed result. A foreground
`endo up --harness claude` agent with `backend = "claude"` was also incepted headlessly
by `claude -p` and answered a request end to end.

## Interactive creation

`bun test test/prompts.test.ts` runs the setup prompts in real terminals, checking
Enter defaults, optional empty intent, cancellation, and inline path validation.

`bun test test/native-session.test.ts test/create.test.ts` exercises a real Bun PTY
and CLI completion helper with offline Codex and Claude Code stand-ins. It covers exact thread
resume, cancellation, missing completion, failed exits, terminal restoration,
suppression of automatic shutdown output after an authenticated finish signal,
draft recovery, concurrent owner edits, validation, and worktree identity without
model calls. Native setup requires Bun 1.3.5 or later on macOS or Linux and a
signed-in Codex CLI. The shutdown/resume mechanism was smoke-tested with Codex
0.155.1, including quitting while a tool was active. The native create → finish →
resume → edit → finish flow was also verified against a temporary repository; the
same thread was retained and both publications passed validation. Endograph
prompts after terminal shutdown were separately verified. No development
processes or inception ran in those smoke tests. The Claude Code session (2.1.280)
was smoke-tested the same way: `--session-id` start, ready/finish handshake while a
tool was active, `/exit` shutdown, and `--resume` of the same session, including
when launched from inside another Claude Code session.
`bun test test/harnesses.test.ts` covers default selection, fallback, and `endo harness`.

The offline CLI fixture also runs create through both native sessions, verifies
that inception resumes the setup conversation, validates and promotes through the
same host as standalone inception, and checks that startup follows promotion.
Core tests cover pending-session precedence and fresh conversations for later inceptions.
Owner-input tests cover requested staged edits, cancellation/resume, validation with
changed capabilities, inline and relocated manifests, matching snapshot hashes, and
promotion recovery for owner files. A real headless subprocess attempts reads,
writes, and deletion of protected inputs while retaining access to candidate code.

## Interactive inception

The inception tests exercise interactive validation retries, same-thread resume,
cancellation and round exhaustion, source changes between or during sessions,
owner-input protection, and promotion. Offline Codex and Claude Code fixtures run
`endo up --interactive` and `endo incept --interactive` through real PTYs and the
CLI finish helper, with the trusted host's validator. The shared terminal tests
also verify that setup and inception use their respective finish commands.
