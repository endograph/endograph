# Verification

Run `bun test` and `bun run typecheck` with Bun 1.3.10. The sandbox tests launch
real OS-confined child processes and descendants. They use local HTTP services
and fake credentials; no model API key is required.

## Publishing

All three packages share a release version. From the repository root:

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
consumers install the published version. Publishing is sequential: `@endograph/codex-executor`, `endograph`, then
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

The workflow's first successful Linux execution is still needed to establish
Linux support. Running these tests on macOS proves its Seatbelt policy only.

On Linux, a denied file may be masked by a read-only `/dev/null` mount. Tests
assert that protected contents are unavailable, accepting either an access error
or an empty masked file.

## Codex backend

`bun test packages/codex-executor/test test/codex-host.test.ts` checks session
reuse, recovery, tool validation, cancellation and the real stdio/host IPC path
using an offline app-server fixture. It needs neither Codex login nor model
inference. The native protocol setup was also smoke-tested with Codex 0.153.3
(`initialize` and `thread/start` with dynamic tools, no model turn). See
[the executor package](../packages/codex-executor/README.md) for configuration
and context semantics.
