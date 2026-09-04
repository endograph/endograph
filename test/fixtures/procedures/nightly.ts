import { procedure } from "endograph/procedure";

await procedure({ description: "A scheduled check", schedule: "* * * * *" });
console.log("checked");
