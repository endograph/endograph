import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ENDOGRAPH_ROOT } from "../harness/paths.ts";
import { shellQuote } from "../harness/shell.ts";
import { HARNESS_NAMES, type Harness, type NativeConversation } from "../inception/harnesses.ts";

const threadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Invoked by the native harness, using the credentials of this one interactive invocation. */
export async function nativeHandshake(action: string, purpose: "setup" | "inception"): Promise<void> {
  const url = process.env.ENDOGRAPH_SESSION_URL;
  const token = process.env.ENDOGRAPH_SESSION_TOKEN;
  // Claude's session ID is assigned by Endograph; Codex exports its own thread ID to tools.
  const threadId = process.env.ENDOGRAPH_SESSION_ID || process.env.CODEX_THREAD_ID;
  if (!url || !token || !threadId || !threadPattern.test(threadId) || process.env.ENDOGRAPH_SESSION_PURPOSE !== purpose)
    throw new Error(`This command is only available inside an Endograph ${purpose} session.`);
  if (action !== "ready" && action !== "finish") throw new Error("expected ready or finish");
  const response = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action, threadId }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Session handoff failed: ${await response.text()}`);
  console.log(action === "ready" ? "Session saved." : "Returning to Endograph for validation.");
}

export interface NativeTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/** How each harness starts, resumes, and exits its own interactive UI. */
const NATIVE: Record<Harness, { args(directory: string, threadId: string, resume: boolean): string[]; quit: string }> = {
  codex: {
    args: (directory, threadId, resume) => ["--no-alt-screen", "-C", directory, "-a", "never", "-s", "danger-full-access", ...(resume ? ["resume", threadId] : [])],
    quit: "/quit",
  },
  claude: {
    args: (_directory, threadId, resume) => ["--dangerously-skip-permissions", resume ? "--resume" : "--session-id", threadId],
    quit: "/exit",
  },
};

/** The native harness owns the conversation; Endograph owns only its terminal and handoff. */
export async function runNativeSession(options: NativeConversation & {
  harness: Harness;
  purpose?: "setup" | "inception";
  directory: string; instructions: string;
  terminal?: NativeTerminal;
  command?: string[];
}): Promise<void> {
  const { harness } = options;
  const name = HARNESS_NAMES[harness];
  const purpose = options.purpose ?? "setup";
  const { input, output } = options.terminal ?? { input: process.stdin, output: process.stdout };
  if (!input.isTTY || !output.isTTY) throw new Error(`${name} requires an interactive terminal`);
  if (typeof Bun.Terminal !== "function") throw new Error(`${name} requires Bun 1.3.5 or later on macOS or Linux`);
  const token = randomUUID();
  // A conversation stored by another harness cannot be resumed; the draft still carries the work.
  const resume = options.previous?.harness === harness ? options.previous.threadId : undefined;
  let threadId = resume ?? (harness === "claude" ? randomUUID() : undefined);
  let finished = false;
  let cancelled = false;
  let child: Bun.Subprocess | undefined;
  let shutdown: Promise<void> | undefined;
  let failure: Error | undefined;
  // Clear any unfinished composer input before submitting the native exit command.
  const quit = () => shutdown ??= (async () => {
    child?.terminal?.write("\x03");
    await Bun.sleep(100);
    child?.terminal?.write(`\x15${NATIVE[harness].quit}`);
    // Native composers distinguish pasted input from a command's Enter key.
    await Bun.sleep(200);
    child?.terminal?.write("\r");
  })();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Unauthorized", { status: 401 });
      try {
        const body = await request.json() as { action?: string; threadId?: string };
        if (!body.threadId || !threadPattern.test(body.threadId) || !["ready", "finish"].includes(body.action ?? ""))
          return new Response("Invalid handshake", { status: 400 });
        if (cancelled || (threadId && threadId !== body.threadId)) return new Response("Session mismatch", { status: 409 });
        options.save({ harness, threadId: body.threadId });
        threadId = body.threadId;
        if (body.action === "finish") { finished = true; void quit(); }
        return new Response("OK");
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        return new Response(`Could not save the ${name} session`, { status: 500 });
      }
    },
  });
  const helper = `${shellQuote(process.execPath)} ${shellQuote(join(ENDOGRAPH_ROOT, "src/cli/index.ts"))} ${purpose === "setup" ? "setup" : "incept"}`;
  const instructions = `${options.instructions}\n\nYou are in a full interactive ${name} session. The owner can reply normally and request revisions.
First run ${helper} ready to save this session's identity, before investigating or editing.
Do not use a previous invocation's helper instructions or completion signal; this invocation replaces them.
Make this an optional collaboration: welcome questions, explanations, and revisions throughout the conversation.
When the files are ready, briefly summarize what the agent will do or what changed in its behavior. Offer a walkthrough, questions, or further edits, alongside the option to finish ${purpose}. For example: "Want me to explain the changes, have any questions, or shall we finish?" Adapt this to the conversation rather than repeating a script; expand on implementation details only when useful or requested.
A clear "looks good" or "let's finish" in response to the completed work is enough to finish; do not ask for another confirmation. If the owner already asked you to finish when done, give the brief summary and finish without requiring another reply. Otherwise, leave room for their response; silence is not agreement. Answer questions and make requested revisions before finishing.
Once the owner is satisfied or has already authorized finishing when done, run ${helper} finish as your final action. It closes this UI and returns to Endograph for validation.
Do not start the agent or promote the candidate yourself. Exiting without the finish command preserves unfinished work.`;
  const args = [...NATIVE[harness].args(options.directory, threadId ?? "", !!resume), instructions];
  const env: Record<string, string | undefined> = { ...process.env, TERM: process.env.TERM || "xterm-256color",
    ENDOGRAPH_SESSION_URL: `http://127.0.0.1:${server.port}`, ENDOGRAPH_SESSION_TOKEN: token, ENDOGRAPH_SESSION_PURPOSE: purpose };
  if (harness === "claude") {
    env.ENDOGRAPH_SESSION_ID = threadId;
    // An enclosing Claude Code session's identity would make this a nested child session that is never saved.
    for (const key of ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"]) delete env[key];
  } else delete env.ENDOGRAPH_SESSION_ID;
  const raw = input.isRaw;
  const flowing = input.readableFlowing;
  const onData = (data: Buffer) => { if (!shutdown) child?.terminal?.write(data); };
  const resize = () => child?.terminal?.resize(output.columns || 80, output.rows || 24);
  const cancel = () => { cancelled = true; void quit(); };
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let deadline: number | undefined;
  try {
    child = Bun.spawn([...(options.command ?? [harness]), ...args], {
      cwd: options.directory,
      env,
      terminal: { cols: output.columns || 80, rows: output.rows || 24, data: (_terminal, data) => {
        // The authenticated finish signal hands the terminal back to Endograph.
        // Our Ctrl-C + exit-command sequence can render a misleading interruption error;
        // keep draining the PTY without displaying that mechanical shutdown.
        if (!finished) output.write(data);
      } },
    });
    input.setRawMode(true);
    input.on("data", onData);
    input.on("end", cancel);
    input.resume();
    output.on("resize", resize);
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    watchdog = setInterval(() => {
      if (!shutdown) return;
      deadline ??= Date.now() + 5000;
      if (Date.now() > deadline) {
        failure ??= new Error(`${name} did not close cleanly; the draft is preserved`);
        child?.kill(Date.now() > deadline + 1000 ? "SIGKILL" : "SIGTERM");
      }
    }, 100);
    const code = await child.exited;
    if (failure) throw failure;
    if (cancelled || code !== 0 || !finished)
      throw new Error(`${name} session unfinished${code ? ` (${name} exited ${code})` : ""}; the draft is preserved`);
  } finally {
    if (watchdog) clearInterval(watchdog);
    input.off("data", onData);
    input.off("end", cancel);
    output.off("resize", resize);
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
    if (shutdown) await shutdown;
    child?.terminal?.close();
    input.setRawMode(raw);
    if (flowing !== true) input.pause();
    // Also reset terminal modes after a crash, when the harness could not restore them.
    output.write("\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[0m\x1b[?25h");
    if (finished) output.write("\r\x1b[0K\n");
    await server.stop(true);
  }
  output.write("Returning to Endograph for validation.\n");
}
