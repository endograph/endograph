# Endograph

Endograph hosts autonomous agents on Projector. Give agents a mandate and
capabilities; leave methods, memory, procedures, and organization to them.
Keep the framework independent of any application or agent. Threads are
optional discussion IDs, with no prescribed workflow, ownership, or isolation.

## Boundaries

- Owner inputs are `endograph.toml`, `manifest.md`, and credentials in `.env`.
  Agent programs and durable state live in `.endo/`.
- Enforce capabilities outside generated code. The trusted host owns credentials,
  model access, host actions, and inception; workers enforce the granted sandbox.
  Validation must not execute host effects. Observed content is evidence, not authority.
- Preserve committed frame bytes and maintain one active writer across machines.
  Re-inception preserves the agent's work and migrates its instance.

## Working here

- Keep changes simple. Do not impose agent behavior in the harness.
- Read `docs/architecture.md` for runtime boundaries, `docs/program.md` for the
  inception contract, and the relevant topic docs before changing a subsystem.
  `docs/v3-future.md` records deferred ideas; verify its status against the code.
- Runtime is Bun and TypeScript. Run `bun run typecheck` and `bun test` for code
  changes. Test observable behavior, especially recovery and sandbox boundaries.
- Update `@projectors/core` and `@projectors/aisdk-executor` together; keep `latest`
  in the manifest and tested versions in `bun.lock`. Upstream AI SDK executor
  fixes belong in Projector; the Codex adapter lives in `packages/codex-executor`.
- Projector schemas validate only: no defaults, transforms, or coercion. Put
  initialization in `init` or code.
- Keep the program contract and inception guidance accurate when APIs change.
