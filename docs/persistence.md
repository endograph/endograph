# Persisting an agent

The durable record is `.endo/frames/`: the frame archive, one record per
store transaction, holding full frames and, when written, an instance
checkpoint. One record is one transaction, so inception's frame and
migrated instance become visible together. Ordinary frame appends are
published as they are produced. Runtime checkpoints are also saved after
activations.

## The archive on disk

Two encodings share the directory. Agents written before segments have a
prefix of immutable `<commit>.json` files, one commit each; they are never
rewritten, and the byte-for-byte copy of that prefix stays valid. Everything
after that prefix goes into append-only `<first commit>.jsonl` segments: one
JSON record per line, flushed before the transaction commits. A record is
published once its terminating newline is on disk. A segment is named by its
first commit, so the segment after commit `n` is always `<n+1>.jsonl`, and
reading the archive needs no directory listing beyond the first open.

The store rotates to a fresh segment before an append once the active one
holds about 1000 frames or 16 MiB. Rotation happens only between
transactions; a transaction is never split across segments, so a large
checkpoint can push a segment past either bound.

Recovery rules, applied whenever the store opens and at the start of every
write transaction, under the SQLite write lock:

- Legacy files must be `1..n` and segments must chain; a gap, a segment that
  starts elsewhere than the previous one ended, or a database that indexes
  more commits than the archive holds refuses to open.
- A complete line must be valid JSON of the expected shape and commit
  number. Anything else is corruption and fails closed.
- Only the final segment may end in an unterminated line. That is a crash
  during an append, never a published decision; the holder of the write lock
  truncates it before appending. An unterminated line in any earlier segment
  is corruption.

## SQLite: index, inbox, and program tables

`agent.db` is a local index and transactional inbox. It records how far it
has indexed the archive (commit, segment, byte offset), so a normal append
reads nothing but the tail of the active segment. Keep it during normal
operation; the generated `.endo/.gitignore` excludes it and its WAL/SHM
companions. Every appender goes through the store's immediate transaction,
which serialises reconciliation, tail truncation and publication across
processes; a refused `BEGIN` (another writer holds the file) leaves the
caller free to retry, while a failure after publication began poisons the
connection until it is reopened.

If `agent.db` is missing, opening the agent starts from `checkpoint.db` when
one is beside it (below), otherwise from an empty database, and then folds
every archive commit past that point: history, the latest checkpoint,
delivered-message IDs, and canonical replies. Live frame writes and archive
recovery share the same indexing code; appending a request or call frame
records delivery in that transaction, and framework indexes maintained by
other modules register through the store's index hook so replay rebuilds
them too.

Program-owned tables may live in `agent.db` and are written through the
store's connection. Nothing isolates them from the framework's tables, and
the archive knows nothing about them: an archive-only rebuild restores only
what the archive records. They are as durable as the last `checkpoint.db`.
Acceptance without a delivered frame is likewise SQLite-only.

## checkpoint.db

`endo snapshot` writes `.endo/checkpoint.db`: a consistent copy of the live
database (`VACUUM INTO`), taken after the index has caught up with the
archive, so the archive never trails it. It carries every table in the file
and the archive position it stands at. It is not excluded by the generated
ignore file, so a Git checkout of the agent directory that includes the
archive and the checkpoint restores completely: `endo up` copies the
checkpoint to `agent.db` when the live database is absent and folds the
newer archive commits. Stale WAL/SHM files of the missing database are
removed first so they cannot be replayed onto the copy.

This release supports the archive format only. Older SQLite-only agents
must be reset before starting; there is no automatic history import.
Opening an old store reports the incompatibility without modifying its data.

## Taking a snapshot

Run `endo snapshot /path/to/new-directory` in the agent directory (or use
`--agent`). The agent can keep running and appending frames. The command
refreshes the source's `checkpoint.db`, copies the archive byte for byte
through the commit that checkpoint stands at (whole legacy files and
complete segments, the active segment up to that record), copies the
checkpoint and the agent's stable files into a temporary sibling directory,
verifies the copied archive chain and the program against its recorded
inception, checks that the copied files stayed unchanged during capture,
then publishes the completed directory. An existing destination is refused.
If code or owner files change during the copy, retry after those writes
settle. An unfinished inception promotion must complete or be recovered first.

The result contains the grant, manifest, program, evolved `src/`, inception
snapshots and records, the archive prefix, the checkpoint, and other ordinary
files in the agent directory. It excludes the live SQLite database and its
WAL/SHM, inbox/outbox, running procedures' files, logs, local locks,
temporary workspaces, `.endo/local/`, and `.git` / `node_modules` directly under the agent
root or `.endo/`. Nested project files and `.endo/home` are kept.
Credentials in `.env` are also excluded. Symlinks and special files
are refused rather than silently copying external data. External cwd or
grant paths are not bundled; they must exist on the destination host.

To restore, provision credentials and make the Endograph CLI available, then
run `endo up` in the saved directory. It installs owner-project dependencies
from the root package manifest and lockfile before loading agent code; keep
both in the snapshot. Endograph recreates its own module
link, starts SQLite from the checkpoint, and republishes canonical replies.
The saved residence claim is retained; moving to another host may require
`endo up --adopt`. Keep one active writer for an identity. Snapshotting does
not itself stop or move the source.

## Copying while running

The live-copy guarantee applies to the archive: a complete prefix of its
commits can be reconstructed while the source continues appending. Legacy
files and finished segments are immutable; the active segment's copied
prefix is valid up to its last complete line. An interior gap is an
incomplete copy; recovery rejects it rather than silently skipping history.

A complete agent copy also needs the owner inputs, `program/`, `src/`, and
`snapshots/` that match the latest inception in that archive prefix. Include
the promotion journal and rollback directory if a promotion is in progress.
Copying an older archive with newer code can pair an instance with an
incompatible program. Mutable `src/` files can also change during a copy.
Coordinate those files with the matching generation, or use a filesystem
snapshot or a brief pause; independent file copying is not an atomic
snapshot of the entire agent.
Keep mirrored files byte-for-byte; redacting or merging individual JSON
fields changes the recorded state. A copied `checkpoint.db` must travel with
an archive at least as long as the commit it records; a shorter archive
refuses to open.

An archive-only restore can lose pending messages accepted only into the
runtime inbox, program-owned tables, and anything after the last copied
commit. A process restart on the original machine retains all of them.
Unfinished recorded work uses the harness's normal redrive/failure rules.
Neither frame replay nor an instance checkpoint proves that an external side
effect happened exactly once.

If a delivery transaction rolls back after changing the in-memory machine,
the worker stops. The next startup recovers the accepted message from SQLite
and the machine from the committed archive. Internal consistency failures
use this same startup path, rather than rebuilding a live machine in place.

Terminal replies are explicit harness frames, committed before outbox
publication. They survive rebuilding SQLite and prevent a different
terminal answer from replacing the original. They establish that the
sender committed its answer, not that a recipient received it. Recipient
acknowledgements would require a separate receipt protocol.

The generated `.endo/.gitignore` excludes the database, lock, and installed
module link, plus `/local/` for host-owned machine-local state. Executors keep
their session metadata under `.endo/local/executors/<name>/`; it is protected
from sandboxed workers and excluded from snapshots. This state is retained
across restarts, but does not travel with the agent. It is not disposable while
the host is running.

The ignore file is written only once; existing owner-maintained ignore
files need the corresponding exclusions added when adopting this layout.
Provision `.env` separately according to the destination's needs.
Registry entries and service units are per-machine and recreated by `up`.
Owner-authored files and procedure arguments may still contain absolute
paths; those need to make sense on the destination.

## Moving between hosts

Use one writer. Stop the old agent, copy its released status and durable
files, then start the destination. `endo up --adopt` permits recovery when
the old host cannot release its residence.

`status.json` records the holder and allows a running agent to notice a
newer foreign residence record. This is cooperative conflict detection,
not a distributed lease or a fence against a disconnected writer. A file
mirror cannot safely merge two independently appended archives, and two
writers appending to one segment interleave their records. Prevent
overlapping writers outside Endograph; preserve conflicting copies for
inspection rather than resolving their frame files with last-writer-wins.
