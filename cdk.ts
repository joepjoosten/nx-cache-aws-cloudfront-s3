import { loadConfig } from "./src/config.ts";
import { createCacheApp } from "./src/infra/app.ts";

const { app } = await createCacheApp(loadConfig(), {
  account: process.env.CDK_DEFAULT_ACCOUNT,
});
app.synth();
