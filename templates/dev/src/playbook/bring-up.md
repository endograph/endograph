+++
kind = "procedure"
provenance = "template seed — edit for your stack"

[[process]]
name = "backend"
cmd = "echo replace-me: bunx convex dev"
ready = { log = "ready" }
ready_timeout_s = 120

[[process]]
name = "web"
cmd = "echo replace-me: bun run dev"
after = ["backend"]
ready = { http = "http://localhost:3000" }
+++

# Bring-up

The bring-up procedure: which processes make up the dev stack, in what order
they start, and what "ready" really means for each (a probe, never `sleep 5`).

This seed is a placeholder. Describe your real stack: for each process note
the command, the working directory (`cwd`, relative to the project root),
readiness (`ready = { log = "regex" }`, `{ http = "url" }`, or
`{ port = 1234 }`), env vars, and start-order dependencies (`after`).

Prose here is for the next reader — human or agent: why the ordering matters,
which env vars wire processes together, what usually goes wrong on cold start.
