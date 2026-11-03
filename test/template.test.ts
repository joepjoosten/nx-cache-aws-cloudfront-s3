import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { parseConfig } from "../src/config.ts";
import { createCacheApp } from "../src/infra/app.ts";

const config = parseConfig({
  repositories: [
    {
      namespace: "my-repo",
      readWriteTokenSha256: "a".repeat(64),
      readOnlyTokenSha256: "b".repeat(64),
    },
  ],
});
async function synth(ttl = config.signedUrlTtlSeconds) {
  const { stack } = await createCacheApp(
    { ...config, signedUrlTtlSeconds: ttl },
    { account: "111111111111" },
  );
  return Template.fromStack(stack);
}

test("native CDK edge constructs keep artifact bodies outside Lambda and enforce conditional S3 writes", async () => {
  const template = await synth();
  template.resourceCountIs("AWS::Lambda::Function", 2);
  template.resourceCountIs("AWS::Lambda::Version", 2);
  template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: {
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        LambdaFunctionAssociations: Match.arrayWith([
          Match.objectLike({ EventType: "viewer-request", IncludeBody: false }),
          Match.objectLike({
            EventType: "origin-response",
            IncludeBody: false,
          }),
        ]),
      },
      Origins: Match.arrayWith([
        Match.objectLike({ OriginAccessControlId: Match.anyValue() }),
      ]),
    },
  });
  template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
    OriginAccessControlConfig: {
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    },
  });
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: "RequireWriteOnce",
          Effect: "Deny",
          Action: "s3:PutObject",
          Condition: { StringNotEquals: { "s3:if-none-match": "*" } },
        }),
        Match.objectLike({
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:PutObject",
          Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } },
        }),
      ]),
    },
  });
  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain",
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    },
  });
  const functions = template.findResources("AWS::Lambda::Function");
  for (const resource of Object.values(functions)) {
    assert.equal(resource.Properties.Environment, undefined);
    assert.equal(resource.Properties.Architectures?.[0] ?? "x86_64", "x86_64");
    assert.equal(resource.Properties.Timeout, 5);
    assert.equal(resource.DeletionPolicy, "Retain");
  }
  // CDK's EdgeFunction supplies the composite trust policy required by AWS.
  for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
    const principals = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    assert.ok(principals.includes("edgelambda.amazonaws.com"));
    assert.ok(principals.includes("lambda.amazonaws.com"));
  }
  const viewer = Object.entries(functions).find(([id]) =>
    id.startsWith("ViewerFunction"),
  )![1];
  const parts = viewer.Properties.Code.ZipFile["Fn::Join"][1];
  const source = parts
    .map((part: unknown) => (typeof part === "string" ? part : "test-bucket"))
    .join("");
  const module = { exports: {} as { handler: Function } };
  runInContext(
    source,
    createContext({
      module,
      exports: module.exports,
      Buffer,
      require: (name: string) => {
        if (name === "node:crypto")
          return { createHash() {}, timingSafeEqual() {} };
        if (name === "@aws-sdk/client-s3")
          return { S3Client: class {}, GetObjectCommand: class {} };
        if (name === "@aws-sdk/s3-request-presigner")
          return { getSignedUrl() {} };
        throw new Error(`Unexpected deployment dependency: ${name}`);
      },
    }),
  );
  assert.equal(typeof module.exports.handler, "function");
});

test("CDK publishes a new viewer version for config changes without replacing the function", async () => {
  const before = await synth();
  const after = await synth(600);
  const viewerVersions = (template: Template) =>
    Object.keys(template.findResources("AWS::Lambda::Version")).filter((id) =>
      id.startsWith("ViewerFunction"),
    );
  const responseVersions = (template: Template) =>
    Object.keys(template.findResources("AWS::Lambda::Version")).filter((id) =>
      id.startsWith("ResponseFunction"),
    );
  assert.notDeepEqual(viewerVersions(before), viewerVersions(after));
  assert.deepEqual(responseVersions(before), responseVersions(after));
  assert.deepEqual(
    Object.keys(before.findResources("AWS::Lambda::Function")),
    Object.keys(after.findResources("AWS::Lambda::Function")),
  );
});
