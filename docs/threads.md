# Threads and inspection

A thread is a persistent discussion ID with a title and JSON metadata. It has
no owner, membership, authentication, or separate agent instance. Applications
choose who can access it. The agent chooses how discussions inform its work.
`thread` groups messages; `ref` can still describe their subject.

Thread changes are frames. SQLite indexes them and request/reply associations;
rebuilding from the archive restores empty threads, metadata, and conversations.
Only the explicit `thread` field associates a message with a discussion.
`ref` is opaque and never interpreted as a thread ID. An unknown thread ID
creates an untitled discussion; message text never determines its title.
Applications or the agent can set titles and metadata explicitly.
Unthreaded CLI, scheduled, and agent messages remain in the global message view.

`endo api` reads one JSON object on stdin and returns JSON. It never imports the
agent program. The same local interface is `agentQuery(agentDir, operation)` from
`endograph/client`. Access control belongs to the caller.

Operations:

- `threads.create`: optional `id`, `title`, `metadata`. Repeating the ID is idempotent.
- `threads.list`, `threads.update` (`id`, optional `title`, `archived`, `metadata`).
- `messages.send`: `id`, `threadId`, `text`. Records and queues immediately, even
  while stopped. Retrying the same ID/content does not deliver twice.
- `messages.list`: optional `threadId`, `before`, `limit`. Chronological pages of
  requests, calls, replies and notifications. No thread means the entire agent.
- `frames.list`: optional `before`, `limit`, `type`, `query`. Newest first, summaries.
- `frames.get`: `seq`. Complete frame, including tool input/output and state events.
- `overview`: runtime status and the persisted machine checkpoint.

Pages return `nextBefore`; omit it for the newest page. Message pages keep all
messages in a boundary frame together. Frame numbers link conversations to the
underlying record; scheduled work need not belong to a thread.

The core `threads` action exposes list/get/create/update/messages. Inception can
include it wherever useful; Endograph prescribes no discussion workflow.
