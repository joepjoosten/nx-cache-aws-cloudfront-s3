import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { createRequire } from "node:module";
import { S3Client } from "@aws-sdk/client-s3";
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

test("regional storage has one policy owner, a regional origin and correct download signatures", async () => {
  const { app, stack, storageStack } = await createCacheApp(
    { ...config, bucketRegion: "eu-west-1" },
    { account: "111111111111" },
  );
  assert.ok(storageStack);
  assert.equal(stack.region, "us-east-1");
  assert.equal(storageStack.region, "eu-west-1");
  const edge = Template.fromStack(stack);
  const storage = Template.fromStack(storageStack);
  edge.resourceCountIs("AWS::S3::Bucket", 0);
  edge.resourceCountIs("AWS::S3::BucketPolicy", 1);
  edge.resourceCountIs("AWS::Lambda::Function", 2);
  storage.resourceCountIs("AWS::S3::Bucket", 1);
  storage.resourceCountIs("AWS::S3::BucketPolicy", 0);
  storage.resourceCountIs("AWS::Lambda::Function", 0);
  storage.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  edge.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: "RequireTLS",
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
        Match.objectLike({
          Sid: "RequireWriteOnce",
          Effect: "Deny",
          Condition: { StringNotEquals: { "s3:if-none-match": "*" } },
        }),
        Match.objectLike({
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:PutObject",
        }),
      ]),
    },
  });
  const bucket = Object.values(storage.findResources("AWS::S3::Bucket"))[0];
  const bucketName = bucket.Properties.BucketName;
  const distribution = Object.values(
    edge.findResources("AWS::CloudFront::Distribution"),
  )[0];
  assert.ok(
    JSON.stringify(distribution.Properties.DistributionConfig.Origins).includes(
      "s3.eu-west-1.",
    ),
  );
  const policy = Object.values(edge.findResources("AWS::S3::BucketPolicy"))[0];
  assert.equal(policy.Properties.Bucket, bucketName);

  // Execute the actual bundled handler with the real AWS presigner and fake
  // static signing credentials: no AWS account/network access is required.
  const viewer = Object.entries(
    edge.findResources("AWS::Lambda::Function"),
  ).find(([id]) => id.startsWith("ViewerFunction"))![1];
  const source = viewer.Properties.Code.ZipFile;
  assert.equal(typeof source, "string");
  const token = "regional-signing-test-token-".repeat(3);
  const require = createRequire(import.meta.url);
  const { createHash } = require("node:crypto");
  const digest = createHash("sha256").update(token).digest("hex");
  const module = { exports: {} as { handler: Function } };
  class TestS3Client extends S3Client {
    constructor(options: ConstructorParameters<typeof S3Client>[0]) {
      super({
        ...options,
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
      });
    }
  }
  runInContext(
    source.replace("a".repeat(64), digest),
    createContext({
      module,
      exports: module.exports,
      Buffer,
      require: (name: string) =>
        name === "@aws-sdk/client-s3"
          ? { ...require(name), S3Client: TestS3Client }
          : require(name),
    }),
  );
  const result = await module.exports.handler({
    Records: [
      {
        cf: {
          request: {
            method: "GET",
            uri: "/v1/cache/12345",
            querystring: "",
            headers: { authorization: [{ value: `Bearer ${token}` }] },
          },
        },
      },
    ],
  });
  assert.equal(result.status, "302");
  const url = new URL(result.headers.location[0].value);
  assert.equal(url.hostname, `${bucketName}.s3.eu-west-1.amazonaws.com`);
  assert.ok(
    url.searchParams
      .get("X-Amz-Credential")
      ?.includes("/eu-west-1/s3/aws4_request"),
  );

  const assembly = app.synth();
  const edgeArtifact = assembly.getStackArtifact(stack.artifactId);
  assert.ok(
    edgeArtifact.dependencies.some(
      (dependency) => dependency.id === storageStack.artifactId,
    ),
  );
  assert.ok(
    !assembly
      .getStackArtifact(storageStack.artifactId)
      .dependencies.some((dependency) => dependency.id === stack.artifactId),
  );
});

test("default placement preserves the original bucket and distribution logical IDs", async () => {
  const { stack, storageStack } = await createCacheApp(config, {
    account: "111111111111",
  });
  assert.equal(storageStack, undefined);
  const template = Template.fromStack(stack);
  assert.equal(
    Object.keys(template.findResources("AWS::S3::Bucket"))[0],
    "CacheBucket41D9D0B0",
  );
  assert.equal(
    Object.keys(template.findResources("AWS::CloudFront::Distribution"))[0],
    "Distribution830FAC52",
  );
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
