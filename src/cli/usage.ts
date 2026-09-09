/**
 * The CLI surface, in two halves. The consumer half is what a peer needs
 * and is rendered into the inception workspace as CLI.md, so a program
 * can tell peers how to reach the agent without guessing.
 */

export const CONSUMER_DOC = `# Reaching an agent: the \`endo\` CLI

Any process that can write a file is a client; \`endo\` is the convenience.
\`--agent <name|dir>\` names the agent (a registered name from
\`~/.endograph/agents/\`, or a directory holding \`endograph.toml\`); without
it, the current directory must be the agent directory.

    endo --agent <name> send [--id <id>] [--ref <r>] [--wait] <text>
    endo --agent <name> call [--wait] <procedure> KEY=VAL ...
    endo --agent <name> wait <id>
    endo --agent <name> commands
    endo --agent <name> status

- \`send\` drops a request and prints its id at once. It stamps \`origin\`
  (the caller's current directory) and \`ref\` (that directory's git
  \`HEAD\`, with \`-dirty\` when the tree has uncommitted changes; \`--ref\`
  overrides; nothing when not in a git repository). \`--wait\` blocks for
  the terminal reply instead and prints its text. \`--id\` supplies the id
  (a retried job with the same id is delivered once).
- \`call\` runs an exposed procedure without waking the model and prints
  its first reply (the ack, or the result); \`--wait\` waits for the
  terminal reply. Unknown or unexposed names are rejected with the list of
  exposed procedures.
- \`wait <id>\` blocks until the terminal reply to a request or call and
  prints its text.
- The inbox is a mailbox: \`send\` and \`call\` queue whether or not the
  agent is up, and what queued is served when it comes up. When it is not
  up (inception holds it, the service crashed, nothing runs it) they say so
  on stderr, with the reason; \`--wait\` then waits until it is.
- \`commands\` lists the exposed procedures with their arguments.
- \`status\` prints whether the agent is up (and why not, when it is not),
  open requests, running procedures, and the last frames.

Exit codes: 0 when the reply says ok (or \`send\`/\`call\` returned an id or
an ack), 1 when the reply is failed or rejected, 2 for usage. Replies also
sit in \`.endo/outbox/<id>.json\` as \`{ id, ok, state, text, at }\`.
`;

export const USAGE = `endo — embedded agents

owner:
  endo up [--foreground] [--inceptor <cmd>]   run this directory's agent under launchd/systemd (incepting first if its program is missing or cannot load)
  endo up --adopt                             run a state directory another host still holds (a copy, a synced mirror); the move is a frame
  endo down                                   stop the service and remove its unit
  endo logs [-f]                              the service log
  endo incept [--manual|--accept] [--inceptor <cmd>]
                                              re-incept: headless, or render the workspace and stop / validate and record
  endo up --template <dir>                    seed endograph.toml + manifest.md from <dir> first; with neither and no template, endo asks
  endo doctor                                 grant, program, registry, unit, env, procedures, inputs vs the last inception
  endo observatory [--port <n>] [--no-open]   open a live, read-only localhost view of projector and inception
  endo charter                                the provisions as the inceptor sees them
  endo replay [<id>] | endo why <id>          the frame log, or the frames about one request or call
  endo snapshot <directory>                  copy durable agent files and a fixed archive prefix while running
  endo reset [--force]                        remove .endo: the next up incepts a fresh agent
  endo                                        list registered agents

consumer (see CLI.md in an inception workspace):
  endo [--agent <name|dir>] send [--id <id>] [--ref <r>] [--wait] <text>
  endo [--agent <name|dir>] call [--wait] <procedure> KEY=VAL ...
  endo [--agent <name|dir>] wait <id>
  endo [--agent <name|dir>] commands
  endo [--agent <name|dir>] status
`;
