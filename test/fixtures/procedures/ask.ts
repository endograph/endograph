import { actionResult, emitMessage, procedure, waitForCompletion } from "endograph/procedure";

await procedure({ description: "Ask the agent something and report its answer", expose: true });
actionResult("asking");
const reply = await waitForCompletion(emitMessage({ text: "what is 2+2?" }), { timeoutMs: 20000 });
console.log(`agent said: ${reply.text}`);
