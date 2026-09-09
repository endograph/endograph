// Offline app-server fixture. The integration test makes an executable copy.
import { createInterface } from "node:readline";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadId = "";
let turnId = "";
let callId = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "config/read") send({ id: m.id, result: { config: {} } });
  else if (m.method === "thread/start" || m.method === "thread/resume") {
    threadId = m.params.threadId ?? crypto.randomUUID();
    send({ id: m.id, result: { thread: { id: threadId } } });
  } else if (m.method === "turn/start") {
    turnId = crypto.randomUUID();
    const text: string = m.params.input[0].text;
    const projection = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const latest = (projection.history ?? []).findLast((v: any) => v.type === "user" && v.text?.startsWith("[request id="));
    const id = latest?.text.match(/\[request id=(\S+)/)?.[1];
    if (!id) throw new Error("Fixture received no new Endograph request");
    send({ id: m.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    send({ id: ++callId, method: "item/tool/call", params: { threadId, turnId, callId: `call-${callId}`, tool: "endograph_call", arguments: { name: "reply", arguments: { id, ok: true, text: `served by ${threadId}` } } } });
  } else if (!m.method && m.result) {
    if (!m.result.success) throw new Error(JSON.stringify(m.result));
    send({ method: "item/completed", params: { threadId, turnId, item: { id: `answer-${turnId}`, type: "agentMessage", phase: "final_answer", text: "Request settled." } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
