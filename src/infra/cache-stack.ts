import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { CacheConfig } from "../config.ts";
import { BUCKET_PLACEHOLDER, type EdgeBundles } from "./bundle.ts";

export interface CacheStackProps extends StackProps {
  config: CacheConfig;
  bundles: EdgeBundles;
  regionalBucketName?: string;
}

export class CacheStack extends Stack {
  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id, props);
    if (this.region !== "us-east-1")
      throw new Error("Deploy this stack in us-east-1 for Lambda@Edge");
    // Preserve the existing single-stack bucket and its logical ID by default.
    // In other regions use an explicit name shared by both stacks, without a
    // cross-region CloudFormation resource reference or a dependency cycle.
    if (
      props.config.bucketRegion !== "us-east-1" &&
      !props.regionalBucketName
    ) {
      throw new Error(
        "A regional storage bucket is required outside us-east-1",
      );
    }
    const bucket = props.regionalBucketName
      ? s3.Bucket.fromBucketAttributes(this, "RegionalCacheBucket", {
          bucketName: props.regionalBucketName,
          region: props.config.bucketRegion,
        })
      : new s3.Bucket(this, "CacheBucket", {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          removalPolicy: RemovalPolicy.RETAIN,
          lifecycleRules: [
            {
              id: "ExpireArtifacts",
              prefix: "cache/",
              expiration: Duration.days(props.config.retentionDays),
              abortIncompleteMultipartUploadAfter: Duration.days(1),
            },
          ],
        });
    if (props.regionalBucketName) {
      // CloudFormation explicitly supports cross-region S3 BucketPolicy
      // management from us-east-1. Keep the policy next to the distribution
      // so its ARN is local, without cross-region exports/custom resources.
      bucket.policy = new s3.BucketPolicy(this, "RegionalBucketPolicy", {
        bucket,
      });
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "RequireTLS",
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:*"],
          resources: [bucket.bucketArn, bucket.arnForObjects("*")],
          conditions: { Bool: { "aws:SecureTransport": "false" } },
        }),
      );
    }
    // CDK's OAC origin grants writes to the distribution. Explicitly deny
    // non-conditional writes as well, so neither that grant nor another IAM
    // Allow can bypass write-once semantics for cache objects.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "RequireWriteOnce",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("cache/*")],
        conditions: { StringNotEquals: { "s3:if-none-match": "*" } },
      }),
    );

    const edgeRole = (id: string) =>
      new iam.Role(this, id, {
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal("lambda.amazonaws.com"),
          new iam.ServicePrincipal("edgelambda.amazonaws.com"),
        ),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSLambdaBasicExecutionRole",
          ),
        ],
      });
    const viewerRole = edgeRole("ViewerRole");
    const responseRole = edgeRole("ResponseRole");
    const viewer = new cloudfront.experimental.EdgeFunction(
      this,
      "ViewerFunction",
      {
        role: viewerRole,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        handler: "index.handler",
        memorySize: 128,
        timeout: Duration.seconds(5),
        code: lambda.Code.fromInline(
          props.bundles.viewer.replace(BUCKET_PLACEHOLDER, bucket.bucketName),
        ),
        currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      },
    );
    viewer.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("cache/*")],
      }),
    );
    // Missing signed downloads must return 404, rather than S3's permission-
    // ambiguous 403. No list operation is exposed by the HTTP handler.
    viewer.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
      }),
    );
    const response = new cloudfront.experimental.EdgeFunction(
      this,
      "ResponseFunction",
      {
        role: responseRole,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        handler: "index.handler",
        memorySize: 128,
        timeout: Duration.seconds(5),
        code: lambda.Code.fromInline(props.bundles.response),
        currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      },
    );
    const originPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "UploadOriginRequestPolicy",
      {
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          "Content-Type",
          "If-None-Match",
          "X-Amz-Content-Sha256",
        ),
      },
    );
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Nx cache: CloudFront uploads, direct S3 downloads",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessLevels: [cloudfront.AccessLevel.WRITE],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        // CloudFront requires all methods to enable PUT; the viewer handler
        // rejects everything except authenticated GET and PUT.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: originPolicy,
        compress: false,
        edgeLambdas: [
          {
            functionVersion: viewer.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
            includeBody: false,
          },
          {
            functionVersion: response.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
            includeBody: false,
          },
        ],
      },
      errorResponses: [
        { httpStatus: 403, ttl: Duration.seconds(0) },
        { httpStatus: 404, ttl: Duration.seconds(0) },
      ],
    });

    // AWS won't delete replicated edge versions immediately. Keep their
    // functions and IAM policies too; document deliberate manual cleanup.
    for (const construct of this.node.findAll()) {
      if (
        construct instanceof CfnResource &&
        [
          "AWS::Lambda::Function",
          "AWS::Lambda::Version",
          "AWS::IAM::Role",
          "AWS::IAM::Policy",
        ].includes(construct.cfnResourceType)
      ) {
        construct.applyRemovalPolicy(RemovalPolicy.RETAIN);
      }
    }
    new CfnOutput(this, "CacheUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "BucketRegion", { value: props.config.bucketRegion });
    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new CfnOutput(this, "ViewerFunctionName", { value: viewer.functionName });
    new CfnOutput(this, "ResponseFunctionName", {
      value: response.functionName,
    });
    new CfnOutput(this, "ViewerRoleName", { value: viewerRole.roleName });
    new CfnOutput(this, "ResponseRoleName", { value: responseRole.roleName });
  }
}
