// .endo/program/agent.ts — written by inception 1 (2026-09-03). Do not edit:
// change manifest.md or endograph.ts and run `endo incept`.
import { createNode, createSourceInstance, createState, defineProgram, tool, z } from "endograph";

export default defineProgram((endo) => {
  const notes = createState({
    key: "notes",
    schema: z.object({ lines: z.array(z.string()) }),
    init: { lines: [] },
    projection: { render: (v) => ((v as { lines: string[] }).lines.length ? `Notes:\n${(v as { lines: string[] }).lines.join("\n")}` : "") },
  });
  const root = createNode({
    key: "fixture",
    purpose: "the one generator",
    instructions: "Answer every request with reply.",
    states: [notes],
    parts: [
      tool(endo.actions.reply),
      tool(endo.actions.compact),
      tool(endo.actions.update_state),
      tool(endo.actions.bash),
      tool(endo.actions.spawn),
      tool(endo.actions.cede),
      ...endo.procedures.map((p) => tool(p)),
    ],
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
  return { nodes: [root], instance: createSourceInstance({ id: "agent", node: root }) };
});
