#!/usr/bin/env bun
import { loadAgentEnv, resolveAgentDir } from "../agent/dir.ts";
import { cmdDigest } from "./digest.ts";
import { cmdLearn } from "./learn.ts";
import { cmdReplay, cmdWhy } from "./query.ts";
import { cmdReset } from "./reset.ts";
import { cmdCapex, cmdReply, cmdSend, cmdWait, cmdWorld } from "./send.ts";
import { cmdInstall, cmdRestart, cmdUninstall } from "./service.ts";
import { cmdStatus } from "./status.ts";
import { cmdUp } from "./up.ts";

const USAGE = `endo — embedded agents: a charter, an inbox, a playbook, a frame log

usage:
  endo learn              agent reads its charter, explores the project, writes procedures
  endo up                 run the agent in this terminal: converge, watch the inbox, supervise
  endo install            run it as a launchd user agent instead: now, and at every login
  endo restart            restart that agent (new endograph code; charter/grant/playbook reload live)
  endo uninstall          stop and remove the launchd agent
  endo send [--ref r] [--wait] <text…>
                          leave a request in the agent's inbox; prints the incident id
  endo wait <incident>    block until the agent replies (exit 0 ok / 1 not ok / 2 timeout)
  endo reply <incident> [--failed] <text…>
                          answer a request on the agent's behalf (background jobs, peers)
  endo world set <subject> [--state s] [--kind k] [--data json] <summary…>
  endo world clear <subject>
                          maintain the agent's world model from a script or a peer
  endo capex [ask…]       on-demand research session: distill recent experience into rules
  endo status             one status surface: world model, open requests, recent frames
  endo why <thing>        recent frames about a subject (e.g. "stout", "inc-1a2b")
  endo replay <incident>  full frame sequence of one incident
  endo digest [date]      the day's account: drift, rules, judgment, spend
  endo reset --force      factory-reset: keep config + charter, wipe experience

options:
  --agent <name|path>     which agent: a name in this project, or a path to a
                          directory containing endograph.toml (also: ENDO_AGENT env)
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args: string[] = [];
  let agentName: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agent") agentName = argv[++i];
    else if (a === "--force") force = true;
    else args.push(a);
  }
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  const dir = resolveAgentDir(process.cwd(), agentName);
  loadAgentEnv(dir);
  switch (command) {
    case "up":
      return cmdUp(dir);
    case "install":
      return cmdInstall(dir);
    case "uninstall":
      return cmdUninstall(dir);
    case "restart":
      return cmdRestart(dir);
    case "learn":
      return cmdLearn(dir);
    case "status":
      return cmdStatus(dir);
    case "why":
      if (!rest[0]) throw new Error("usage: endo why <thing>");
      return cmdWhy(dir, rest[0]);
    case "replay":
      if (!rest[0]) throw new Error("usage: endo replay <incident>");
      return cmdReplay(dir, rest[0]);
    case "digest":
      return cmdDigest(dir, rest[0]);
    case "send":
      return cmdSend(dir, rest);
    case "wait":
      return cmdWait(dir, rest);
    case "capex":
      return cmdCapex(dir, rest);
    case "reply":
      return cmdReply(dir, rest);
    case "world":
      return cmdWorld(dir, rest);
    case "reset":
      return cmdReset(dir, force);
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`endo: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
