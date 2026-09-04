# Persisting an agent

The state directory is everything the agent is, and it is written so that
any file mirror can carry it: a `cp -r`, an rsync, a synced git checkout.
Endograph knows nothing about the mirror. It keeps three promises about
`.endo/` and one protocol for moving it, and a mirror that delivers files
into the working tree gets migration and backup out of them.

## The promises

- **A copy taken at any instant is valid.** The frame log is SQLite in WAL
  mode; the WAL is checkpointed into `agent.db` every time the machine
  snapshot is written (after every activation, after every inception), so
  between activations that one file is the whole log. A copy that lands
  mid-checkpoint is healed by the next one.
- **`.endo/.gitignore` says what a copy leaves behind.** `node_modules`
  (one symlink to the endograph that runs the agent; relinked by every
  `up`) and the WAL companions `agent.db-wal` and `agent.db-shm` (empty
  after every quiescence; only this machine's SQLite reads them). Nothing
  else is excluded: `env`, `lock`, `status.json`, `runs/`, the wire, the
  snapshots and inception records all travel. `ensureStateDir` writes the
  file once; it is the owner's after that.
- **Nothing inside stores its own absolute path.** The registry entry and
  the service unit are per machine and outside the directory; `up`
  recreates both.

## Residence

Exactly one machine runs a state directory. `status.json` carries the
`host` that holds it, `running` (true while a harness holds it, false once
it stopped cleanly with `endo down` or Ctrl-C), and `at`, the last write.

- `endo up` on a host that is not the holder refuses while `running` is
  true, and says who holds it. `endo up --adopt` takes it: a `residence`
  frame records the move (`adopted from fox`), and the status is restamped
  with this host, released, so the service can start.
- A running agent reads `status.json` on every poll. When it finds a
  status newer than its own last write from another host, it records
  `adopted by <host>; stopping here`, stops writing the directory, and
  stops (a service also removes its unit). This is the fence: under a
  last-writer-wins mirror, a double run resolves to whichever status was
  written last, and the other side stops instead of appending to a log it
  no longer owns.
- `endo status` and `endo doctor` print the holder.

An orderly move is `endo down` on the old host, let the mirror carry the
released status, then `endo up` on the new one, and no `--adopt` is
needed. `--adopt` is for a host that is gone, asleep, or unreachable. A
double run inside one mirror window is still possible (both hosts write
before either sees the other); the fence closes it within a window, and
the loser's frames stay in its own copy for hand recovery.

## Recipe: a standalone sidecar

[sidecar](https://github.com/anteprojector/sidecar) is a git-based sync
engine whose standalone mode makes a directory its own auto-synced repo:
every change is committed to a per-machine inbox branch, merged into
`main` on the remote, and fast-forwarded back into every other checkout.
Nothing about it is specific to endograph. Persisting an agent with it:

```sh
cd agents/endofrog/.endo
sidecar init git@github.com:you/endofrog-state.git --path . --resolve lww --debounce 10m --interval 1h
```

`--path .` makes the directory its own repository and sidecar (a private
remote; the frame log is binary and passes redaction untouched).
`--resolve lww` keeps the newer write when two machines ever overlap,
which the residence fence turns into a handoff. `--debounce 10m
--interval 1h` is the cadence for a directory a daemon writes: one round
trip an hour says what a commit a minute would. All three land in the
committed `.sidecar`, so every machine agrees. `init` ends with a first
sync, so the whole state directory is on the remote at once. From then on
the daemon syncs it; `sidecar status` says when. Three notes belong to
this recipe and not to the promises above:

- **`env` and redaction.** Sidecar redacts credential-shaped text on
  push and, since redaction is one-way, a clone on another machine would
  receive placeholders in `env`. Put `# sidecar:no-redact` as the first
  line of `env` (the loader skips comment lines), or use `git-crypt` on
  that one path, or init with `--redaction none`.
- **Moving.** After `endo down`, run `sidecar sync` so the released
  status reaches the remote now rather than at the daemon's next pass.
  On the new machine: `git clone <remote> .endo` into the agent
  directory, `sidecar init` there (the committed `.sidecar` answers every
  question), `endo up`. `endo up --adopt` when the old machine cannot
  release.
- **Reset.** `endo reset` deletes `.endo/`, and with it the `.sidecar`
  config inside; the daemon prunes the registration and does not
  re-clone. The remote keeps the history.

Under one writer, every sidecar merge is a fast-forward. Its conflict
strategy only matters when the residence rule is broken, and that is what
the fence is for.
