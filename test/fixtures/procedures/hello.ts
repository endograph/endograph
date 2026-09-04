import { procedure } from "endograph/procedure";
import { z } from "endograph";

const { NAME } = await procedure({ description: "Say hello", expose: true, args: { NAME: z.string() } });
console.log(`hello ${NAME}`);
