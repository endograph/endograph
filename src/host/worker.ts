import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { openAgent, type Agent } from "../harness/agent.ts";
import { loadInceptionRuntime, type RuntimeLoadInput } from "../inception/incept.ts";
import { atomicWrite } from "../protocol/wire.ts";
import { createHostClient } from "./client.ts";
import { ipcTransport } from "./transport.ts";

let shutdown: () => void = () => process.exit(0);
const client = createHostClient({
  transport: ipcTransport(process),
  timeoutMs: 2 * 60 * 60 * 1000, maxBytes: 8 * 1024 * 1024,
  onShutdown: () => shutdown(),
});
const [mode, agentDir, inputFile] = process.argv.slice(2);

if (mode === "load" && inputFile) {
  try {
    const input: RuntimeLoadInput = JSON.parse(readFileSync(inputFile, "utf8"));
    const result = await loadInceptionRuntime(input, client);
    atomicWrite(dirname(inputFile), `${basename(inputFile)}.result`, { ok: true, result });
  } catch (error) {
    atomicWrite(dirname(inputFile), `${basename(inputFile)}.result`, { ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally { client.close(); }
} else if (mode === "run" && agentDir) {
  let agent: Agent | undefined;
  let exitCode: number | undefined;
  const stop = async (code = 0) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    await agent?.stop();
    client.close();
    process.exit(code);
  };
  shutdown = () => { void stop(); };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // The parent may have died after promoting a generation. Do not let this
  // orphan execute or checkpoint its old instance; reopening recovers the log.
  process.on("disconnect", () => process.exit(exitCode ?? 1));
  try {
    agent = await openAgent({
      agentDir, host: client, environmentLoaded: true, log: console.log,
      inception: {
        run: async () => { await client.call("endoIncept", {}); },
        restart: () => void stop(78),
      },
      onAdopted: () => void stop(),
      onFailure: (error) => { console.error(error.message); void stop(1); },
    });
    agent.start();
    console.log(`${agent.name} up in ${agentDir} (${agent.loaded.procedures.length} procedures)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await stop(1);
  }
} else {
  client.close();
  throw new Error("invalid host worker invocation");
}
