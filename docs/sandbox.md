# Sandboxes and host actions

`endo up` uses two processes. The trusted outer process reads the owner's
grant and credentials, registers host actions, calls the model provider,
and runs inception. The inner worker imports the generated program, runs
Projector, and launches procedures. A declared sandbox applies to that
worker and every descendant, including procedure-description processes.
Inception validates generated code in separate workers under the same
policy; it never imports that code into the outer process.
Validation connections can inspect host-action schemas, but the parent rejects
host-action execution and model requests, including direct IPC requests from
generated code. This applies to inception, startup preflight and `endo doctor`.

Reading the grant returns configuration data only. The worker explicitly
binds its batteries, executor and host-action proxies using its IPC client.
The outer process renders schemas and guides for inception without importing
custom executors or constructing executable host proxies.

The grant and charter describe available behavior. The OS sandbox is the
boundary for arbitrary agent-authored code. Removing a host action is
enforced independently by the broker on every call, including calls made
through an old proxy. It cannot undo an external effect already performed.

## Policy

```toml
host_modules = ["./host/sentry.ts"]
host_actions = ["sentryApi"]

[sandbox]
network = "offline"
read = []
write = []
env = []
```

`host_modules` and `host_actions` are top-level grant fields; place them
before `[executor]` or other tables. `network`, `read`, `write`, and `env`
belong inside `[sandbox]`. Omitting that table leaves the worker unsandboxed. An empty table
uses the restrictive defaults shown above.

| Field | Meaning |
| --- | --- |
| `network` | `offline`, `loopback`, `full`, or an array of allowed hosts. Default: `offline`. |
| `read` | Extra readable paths, relative to the agent directory. Agent files, configured cwd, and runtime dependencies are already readable. |
| `write` | Extra writable paths. The state directory is writable by default; owner inputs, program, host implementations, and runtime code remain protected. |
| `env` | Extra environment variables forwarded from the outer process. A small runtime baseline is supplied, with private HOME and TMPDIR under the state directory. |

The worker cannot read or write the owner’s `.env` beside `endograph.toml`.
The outer process loads that file, and provider keys and host-action
credentials stay in that process unless the owner explicitly forwards a
variable. Bun workers and procedure subprocesses disable automatic `.env`
loading. Model traffic uses IPC even with
`network = "offline"`; granting it does not grant arbitrary HTTP access.
Custom executor modules execute inside the worker and must fit its network
and environment policy.

The Codex backend's app-server process runs in the trusted parent environment
with native effectful capabilities disabled; Projector actions still execute
in the worker or through its granted host proxies. `.endo/local/` (including
`executors/codex/`) is protected from worker reads/writes, so generated code cannot replace a persisted thread
association. Authentication remains in the service user's Codex home.

Endograph uses the pinned `@endograph/sandbox-runtime` fork of upstream 0.0.75
(Seatbelt on macOS, bubblewrap on Linux), with the Linux nested writable mount
fix from upstream PR #447 and canonical mount paths for usrmerge systems. See [verification](testing.md) for provenance. Requested enforcement has no
unsandboxed fallback. Linux needs the sandbox runtime's system dependencies.
The inceptor itself remains trusted and runs outside this policy.

## Writing a host action

An owner-managed module can export an action, an array of actions, or a
battery object with a `hostActions` array. Put host code and its helpers in
a dedicated owner directory outside `.endo/`, such as `host/`. The sandbox
protects that entire directory; entries at the agent root, inside `.endo/`,
or through symlinks are rejected.

Host modules use normal owner-project dependency resolution. The owner
project must have `endograph` installed or linked, together with any SDKs
the handlers import. The `.endo/node_modules` link is for generated programs
and procedures; it does not supply dependencies to the sibling `host/`
directory.

```ts
// host/sentry.ts — runs only in the trusted outer process
import { hostAction, HostActionError, z } from "endograph";

export default hostAction({
  name: "sentryApi",
  description: "Read an issue from our Sentry organization.",
  inputSchema: z.object({ issueId: z.string().regex(/^\d+$/) }).strict(),
  async run({ issueId }, { signal }) {
    const org = encodeURIComponent(process.env.SENTRY_ORG!);
    const response = await fetch(
      `https://sentry.io/api/0/organizations/${org}/issues/${issueId}/`,
      {
        headers: { Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}` },
        signal,
        redirect: "error",
      },
    );
    if (!response.ok) throw new HostActionError(`Sentry returned ${response.status}`);
    const issue = await response.json();
    return { id: issue.id, title: issue.title, permalink: issue.permalink };
  },
});
```

The example uses Sentry's [retrieve-issue endpoint](https://docs.sentry.io/api/events/retrieve-an-issue/).
An SDK call works equally well inside `run`. The author writes ordinary
async TypeScript; arguments and results must be JSON values. The broker
validates inputs and supplies an identity bound to the worker connection,
plus an abort signal. Ordinary thrown errors are redacted; use
`HostActionError` for an error intentionally shown to the agent.

The worker receives a normal Projector action at `endo.actions.sentryApi`.
It contains a schema and an IPC proxy. The implementation, SDK clients,
closures, and credentials remain in the parent. The cached
`.endo/host-actions.json` contains descriptions for offline CLI/inceptor
loads; editing it cannot authorize a broker call.

Calls use Node/Bun's private inherited IPC channel, separate from stdout.
The broker checks the current owner grant for each call. Host handlers
should expose concrete operations: accepting arbitrary URLs or shell
commands would grant those operations too.

## Lifecycle

Automatic inception begins when the worker is idle and owner inputs have
changed. The outer process checks the owner change before running the
inceptor. Failed candidates leave the running program in place. After a
successful promotion, the worker exits and a fresh worker starts under
the new grant and sandbox policy. This also discards old executor and
action bindings. Worker replacement is the only automatic-inception path,
including when sandboxing is omitted. If finalization fails after the new
generation committed, it still restarts; if recovery cannot establish the
commit decision, the old worker is terminated. A worker also exits when
its parent disappears.

Embedding applications can use `createAgentHost({ agentDir, actions })`,
then `host.run()` and `host.close()`. The supported host API is this launcher,
`hostAction`, `HostActionError`, and their author-facing types. Broker,
transport and model adapters are internal; native IPC is the sole transport.
`openAgent` alone runs one fixed program generation: it neither performs
automatic inception nor installs an OS sandbox. Ordinary procedure reloads
remain within that generation and preserve conversation history.
The one-second inbox poll also checks procedure and owner-input contents;
reloads do not depend on OS file events, which may be suppressed by a sandbox.
