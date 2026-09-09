# Persisting an agent

The durable record is `.endo/frames/`: immutable, numbered JSON commit
files containing full frames and, when written, an instance checkpoint.
One file contains one transaction, so inception's frame and migrated
instance become visible together. Files are flushed before publication;
temporary files are ignored. Ordinary frame appends are published as they
are produced. Runtime checkpoints are also saved after activations.

SQLite is a local index and transactional inbox. Keep it during normal
operation, but omit `agent.db`, its WAL/SHM companions, and the local lock
from backups. If SQLite is missing, opening the agent rebuilds it from
the archive: history, the latest checkpoint, delivered-message IDs, and
canonical replies. The loader hydrates the checkpoint and folds later
frames without executing historical actions. Each inception's snapshot
also includes `snapshots/<n>/instance.json`.

Live frame writes and archive recovery share the same mailbox indexing code.
Appending a request or call frame records delivery in that transaction;
there is no independent delivery marker for callers to keep in sync.

This release supports the archive format only. Older SQLite-only agents
must be reset before starting; there is no automatic history import.
Opening an old store reports the incompatibility without modifying its data.

## Taking a snapshot

Run `endo snapshot /path/to/new-directory` in the agent directory (or use
`--agent`). The agent can keep running and appending frames. The command
copies a fixed archive prefix and the agent's files into a temporary sibling
directory, checks that the copied files stayed unchanged during capture,
checks the program against its recorded inception, then publishes the
completed directory. An existing destination is refused.
If code or owner files change during the copy, retry after those writes
settle. An unfinished inception promotion must complete or be recovered first.

The result contains the grant, manifest, program, evolved `src/`, inception
snapshots and records, and other ordinary files in the agent directory.
It excludes SQLite, inbox/outbox, running procedures' files, logs, local
locks, temporary workspaces, and `.git` / `node_modules` directly under
the agent root or `.endo/`. Nested project files and `.endo/home` are kept.
Credentials in `.endo/env` are also excluded. Symlinks and special files
are refused rather than silently copying external data. External cwd or
grant paths are not bundled; they must exist on the destination host.

To restore, provision credentials and any owner-project dependencies, then
run `endo up` in the saved directory. Endograph recreates its own module
link, SQLite and canonical replies. The saved residence claim is retained;
moving to another host may require `endo up --adopt`. Keep one active
writer for an identity. Snapshotting does not itself stop or move the source.

## Copying while running

The live-copy guarantee applies to the immutable archive: a complete prefix
of its commits can be reconstructed while the source continues appending.
An interior gap is an incomplete copy; recovery rejects it rather than
silently skipping history.

A complete agent copy also needs the owner inputs, `program/`, `src/`, and
`snapshots/` that match the latest inception in that archive prefix. Include
the promotion journal and rollback directory if a promotion is in progress.
Copying an older archive with newer code can pair an instance with an
incompatible program. Mutable `src/` files can also change during a copy.
Coordinate those files with the matching generation, or use a filesystem
snapshot or a brief pause; independent file copying is not an atomic
snapshot of the entire agent.
Keep mirrored files byte-for-byte; redacting or merging individual JSON
fields changes the recorded state.

An archive-only restore can lose pending messages accepted only into the
runtime inbox, and anything after the last copied commit. A process restart
on the original machine retains that inbox. Unfinished recorded work uses
the harness's normal redrive/failure rules. Neither frame replay nor an
instance checkpoint proves that an external side effect happened exactly
once.

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
module link. It is written only once; existing owner-maintained ignore
files need the database exclusions added when adopting this layout.
Provision `.endo/env` separately according to the destination's needs.
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
mirror cannot safely merge two independently appended archives. Prevent
overlapping writers outside Endograph; preserve conflicting copies for
inspection rather than resolving their frame files with last-writer-wins.
