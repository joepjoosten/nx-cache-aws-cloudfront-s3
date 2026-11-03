import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { buildTemplate } from "../src/infra/template.ts";

const template = await buildTemplate(loadConfig());
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/cloudformation.json",
  JSON.stringify(template, null, 2) + "\n",
);
console.log(
  `Built dist/cloudformation.json (${Buffer.byteLength(JSON.stringify(template))} bytes compact)`,
);
