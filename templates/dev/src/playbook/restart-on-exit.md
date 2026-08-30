+++
kind = "rule"
on = "process.exited"
verb = "restart"
provenance = "template seed"
cooldown_s = 10
+++

# Restart on exit

A process that exits gets restarted with backoff. This is the boring 99%:
zero tokens, instant, reviewed once.

The `restart` verb refuses when a process has restarted 5+ times in 10
minutes; the watcher then emits `process.crashlooping` drift, which no rule
matches — that is deliberate. A crash loop is a diagnosis problem, not a
restart problem, and it escalates to the judgment layer.
