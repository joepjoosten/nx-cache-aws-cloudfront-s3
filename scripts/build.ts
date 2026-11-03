import { mkdir, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createCacheApp } from "../src/infra/app.ts";

const { app } = await createCacheApp(loadConfig());
const assembly = app.synth();
await rm("dist/templates", { recursive: true, force: true });
await rm("dist/cloudformation.json", { force: true });
await mkdir("dist/templates", { recursive: true });
for (const artifact of assembly.stacks) {
  const path = `dist/templates/${artifact.stackName}.template.json`;
  await writeFile(path, JSON.stringify(artifact.template, null, 2) + "\n");
  console.log(`Built ${path} (${artifact.environment.region})`);
}
