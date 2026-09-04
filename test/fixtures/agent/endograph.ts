import { bash, defineAgent, evolve, scheduler } from "endograph";
import { scriptedSpec } from "./scripted.ts";

export default defineAgent({
  name: "fixture",
  executor: scriptedSpec,
  batteries: [bash(), evolve(), scheduler()],
});
