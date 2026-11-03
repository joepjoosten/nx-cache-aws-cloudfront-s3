import { App, Aws, type AppProps } from "aws-cdk-lib";
import { createHash } from "node:crypto";
import type { CacheConfig } from "../config.ts";
import { bundleEdgeHandlers } from "./bundle.ts";
import { CacheStack } from "./cache-stack.ts";
import { StorageStack } from "./storage-stack.ts";

export async function createCacheApp(
  config: CacheConfig,
  options: AppProps & { account?: string } = {},
) {
  const { account, ...appProps } = options;
  const app = new App({ analyticsReporting: false, ...appProps });
  const stackId = "NxCacheAwsCloudfrontS3";
  const suffix = createHash("sha256").update(stackId).digest("hex").slice(0, 8);
  // Account ID is a pseudo parameter when synthesizing offline. Both stacks
  // resolve it independently, so this is not a cross-region stack reference.
  const regionalBucketName =
    config.bucketRegion === "us-east-1"
      ? undefined
      : `nx-cache-${account ?? Aws.ACCOUNT_ID}-${config.bucketRegion}-${suffix}`;
  const storageStack = regionalBucketName
    ? new StorageStack(app, `${stackId}Storage-${config.bucketRegion}`, {
        env: { account, region: config.bucketRegion },
        config,
        bucketName: regionalBucketName,
      })
    : undefined;
  const stack = new CacheStack(app, stackId, {
    env: { account, region: "us-east-1" },
    description:
      "Nx remote cache: CloudFront uploads, direct S3 downloads, deployed with AWS CDK.",
    config,
    bundles: await bundleEdgeHandlers(config),
    regionalBucketName,
  });
  if (storageStack) stack.addStackDependency(storageStack);
  return { app, stack, storageStack };
}
