import { App, type AppProps } from "aws-cdk-lib";
import type { CacheConfig } from "../config.ts";
import { bundleEdgeHandlers } from "./bundle.ts";
import { CacheStack } from "./cache-stack.ts";

export async function createCacheApp(
  config: CacheConfig,
  options: AppProps & { account?: string } = {},
) {
  const { account, ...appProps } = options;
  const app = new App({ analyticsReporting: false, ...appProps });
  const stack = new CacheStack(app, "NxCacheAwsCloudfrontS3", {
    env: { account, region: "us-east-1" },
    description:
      "Nx remote cache: CloudFront uploads, direct S3 downloads, deployed with AWS CDK.",
    config,
    bundles: await bundleEdgeHandlers(config),
  });
  return { app, stack };
}
