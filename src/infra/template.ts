import { createHash } from "node:crypto";
import { build } from "esbuild";
import type { CacheConfig } from "../config.ts";

const ref = (name: string) => ({ Ref: name });
const getAtt = (name: string, attribute: string) => ({
  "Fn::GetAtt": [name, attribute],
});
const sub = (value: string) => ({ "Fn::Sub": value });
const BUCKET_PLACEHOLDER = "NX_CACHE_BUCKET_PLACEHOLDER";
type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
};
export interface CacheTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Resources: Record<string, Resource>;
  Outputs: Record<string, { Value: unknown; Description?: string }>;
}

async function bundle(
  entry: string,
  define?: Record<string, string>,
): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: new URL("../../", import.meta.url).pathname,
    platform: "node",
    target: "node22",
    format: "cjs",
    bundle: true,
    minify: true,
    write: false,
    // Lambda's Node runtime includes AWS SDK v3. This keeps the inline
    // CloudFormation template small; no separate deployment bucket is needed.
    external: ["@aws-sdk/*"],
    define,
  });
  return result.outputFiles[0].text;
}

export async function buildTemplate(
  config: CacheConfig,
): Promise<CacheTemplate> {
  const [viewerCode, responseCode] = await Promise.all([
    bundle("src/edge/entry.ts", {
      __EDGE_CONFIG__: JSON.stringify({
        ...config,
        bucketName: BUCKET_PLACEHOLDER,
        region: "us-east-1",
      }),
    }),
    bundle("src/edge/origin-response.ts"),
  ]);
  const viewerParts = viewerCode.split(BUCKET_PLACEHOLDER);
  if (viewerParts.length !== 2)
    throw new Error("Expected exactly one bucket substitution");
  // A new logical ID publishes a version whenever code or embedded configuration
  // changes. Retain older versions until CloudFront replicas can be cleaned up.
  const release = createHash("sha256")
    .update(viewerCode)
    .update(responseCode)
    .digest("hex")
    .slice(0, 16);
  const viewerVersion = `ViewerVersion${release}`;
  const responseVersion = `ResponseVersion${release}`;
  const resources: Record<string, Resource> = {
    CacheBucket: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        LifecycleConfiguration: {
          Rules: [
            {
              Id: "ExpireArtifacts",
              Status: "Enabled",
              Prefix: "cache/",
              ExpirationInDays: config.retentionDays,
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      },
    },
    EdgeRole: {
      Type: "AWS::IAM::Role",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
              },
              Action: "sts:AssumeRole",
            },
          ],
        },
        ManagedPolicyArns: [
          sub(
            "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ),
        ],
        Policies: [
          {
            PolicyName: "SignCacheReads",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "s3:GetObject",
                  Resource: sub("${CacheBucket.Arn}/cache/*"),
                },
                // S3 requires ListBucket to distinguish a missing key (404) from
                // inaccessible data (403). The HTTP handler never offers listing.
                {
                  Effect: "Allow",
                  Action: "s3:ListBucket",
                  Resource: getAtt("CacheBucket", "Arn"),
                },
              ],
            },
          },
        ],
      },
    },
    ViewerFunction: {
      Type: "AWS::Lambda::Function",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        Runtime: "nodejs22.x",
        Architectures: ["x86_64"],
        Handler: "index.handler",
        Role: getAtt("EdgeRole", "Arn"),
        MemorySize: 128,
        Timeout: 5,
        Code: {
          ZipFile: {
            "Fn::Join": [
              "",
              [viewerParts[0], ref("CacheBucket"), viewerParts[1]],
            ],
          },
        },
      },
    },
    ResponseFunction: {
      Type: "AWS::Lambda::Function",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        Runtime: "nodejs22.x",
        Architectures: ["x86_64"],
        Handler: "index.handler",
        Role: getAtt("EdgeRole", "Arn"),
        MemorySize: 128,
        Timeout: 5,
        Code: { ZipFile: responseCode },
      },
    },
    [viewerVersion]: {
      Type: "AWS::Lambda::Version",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        FunctionName: ref("ViewerFunction"),
        Description: `Cache release ${release}`,
      },
    },
    [responseVersion]: {
      Type: "AWS::Lambda::Version",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        FunctionName: ref("ResponseFunction"),
        Description: `Cache release ${release}`,
      },
    },
    OriginAccessControl: {
      Type: "AWS::CloudFront::OriginAccessControl",
      Properties: {
        OriginAccessControlConfig: {
          Name: sub("${AWS::StackName}-s3"),
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
    },
    UploadOriginRequestPolicy: {
      Type: "AWS::CloudFront::OriginRequestPolicy",
      Properties: {
        OriginRequestPolicyConfig: {
          Name: sub("${AWS::StackName}-upload"),
          CookiesConfig: { CookieBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "none" },
          HeadersConfig: {
            HeaderBehavior: "whitelist",
            Headers: ["Content-Type", "If-None-Match", "X-Amz-Content-Sha256"],
          },
        },
      },
    },
    Distribution: {
      Type: "AWS::CloudFront::Distribution",
      Properties: {
        DistributionConfig: {
          Enabled: true,
          IPV6Enabled: true,
          HttpVersion: "http2and3",
          PriceClass: "PriceClass_100",
          Comment: "Nx cache: CloudFront uploads, direct S3 downloads",
          ViewerCertificate: { CloudFrontDefaultCertificate: true },
          Origins: [
            {
              Id: "CacheS3",
              DomainName: getAtt("CacheBucket", "RegionalDomainName"),
              S3OriginConfig: { OriginAccessIdentity: "" },
              OriginAccessControlId: ref("OriginAccessControl"),
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: "CacheS3",
            ViewerProtocolPolicy: "https-only",
            // CloudFront requires all seven methods to enable PUT; the viewer
            // handler rejects every operation except authenticated GET/PUT.
            AllowedMethods: [
              "GET",
              "HEAD",
              "OPTIONS",
              "PUT",
              "PATCH",
              "POST",
              "DELETE",
            ],
            CachedMethods: ["GET", "HEAD"],
            Compress: false,
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            OriginRequestPolicyId: ref("UploadOriginRequestPolicy"),
            LambdaFunctionAssociations: [
              {
                EventType: "viewer-request",
                LambdaFunctionARN: ref(viewerVersion),
                IncludeBody: false,
              },
              {
                EventType: "origin-response",
                LambdaFunctionARN: ref(responseVersion),
              },
            ],
          },
          CustomErrorResponses: [
            { ErrorCode: 403, ErrorCachingMinTTL: 0 },
            { ErrorCode: 404, ErrorCachingMinTTL: 0 },
          ],
        },
      },
    },
    BucketPolicy: {
      Type: "AWS::S3::BucketPolicy",
      Properties: {
        Bucket: ref("CacheBucket"),
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "CloudFrontConditionalWrites",
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: sub("${CacheBucket.Arn}/cache/*"),
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": sub(
                    "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}",
                  ),
                  "s3:if-none-match": "*",
                },
              },
            },
            {
              Sid: "RequireTLS",
              Effect: "Deny",
              Principal: "*",
              Action: "s3:*",
              Resource: [
                getAtt("CacheBucket", "Arn"),
                sub("${CacheBucket.Arn}/*"),
              ],
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            },
          ],
        },
      },
    },
  };
  const template: CacheTemplate = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "Nx remote cache deployed with Alchemy; upload bytes bypass Lambda and downloads go directly to S3.",
    Resources: resources,
    Outputs: {
      CacheUrl: { Value: sub("https://${Distribution.DomainName}") },
      BucketName: { Value: ref("CacheBucket") },
      DistributionId: { Value: ref("Distribution") },
      ViewerFunctionName: { Value: ref("ViewerFunction") },
      ResponseFunctionName: { Value: ref("ResponseFunction") },
      EdgeRoleName: { Value: ref("EdgeRole") },
    },
  };
  if (Buffer.byteLength(JSON.stringify(template)) > 51_200) {
    throw new Error(
      "Template exceeds CloudFormation's inline limit; reduce configured repositories",
    );
  }
  return template;
}
