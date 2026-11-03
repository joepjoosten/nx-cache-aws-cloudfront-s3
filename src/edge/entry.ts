import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { EdgeConfig } from "../config.ts";
import { createViewerHandler } from "./viewer.ts";

// Substituted by esbuild/CDK; only token hashes are embedded, never bearer tokens.
declare const __EDGE_CONFIG__: EdgeConfig;
const config = __EDGE_CONFIG__;
const s3 = new S3Client({ region: config.region, maxAttempts: 1 });

export const handler = createViewerHandler(config, (key) =>
  getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      ResponseContentType: "application/octet-stream",
    }),
    { expiresIn: config.signedUrlTtlSeconds },
  ),
);
