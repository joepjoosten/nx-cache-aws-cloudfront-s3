import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createCacheApp } from "../src/infra/app.ts";

const { app, stack } = await createCacheApp(loadConfig());
const template = app.synth().getStackArtifact(stack.artifactId).template;
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/cloudformation.json",
  JSON.stringify(template, null, 2) + "\n",
);
console.log(
  `Built dist/cloudformation.json (${Buffer.byteLength(JSON.stringify(template))} bytes compact)`,
);
