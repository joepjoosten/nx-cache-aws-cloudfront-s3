import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { CacheConfig } from "../config.ts";

export interface StorageStackProps extends StackProps {
  config: CacheConfig;
  bucketName: string;
}

/** Regional storage only. The us-east-1 stack owns the bucket's sole policy. */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, "CacheBucket", {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      // Do not enable enforceSSL here: that would create a competing policy.
      // CacheStack owns TLS, write-once and CloudFront permissions together.
      lifecycleRules: [
        {
          id: "ExpireArtifacts",
          prefix: "cache/",
          expiration: Duration.days(props.config.retentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "BucketRegion", { value: this.region });
  }
}
