import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { buildTemplate } from "../src/infra/template.ts";

const config = parseConfig({
  repositories: [
    {
      namespace: "my-repo",
      readWriteTokenSha256: "a".repeat(64),
      readOnlyTokenSha256: "b".repeat(64),
    },
  ],
});
test("deployable bundles and template keep all artifact bodies outside Lambda", async () => {
  const template = await buildTemplate(config);
  const resources = template.Resources;
  assert.ok(Buffer.byteLength(JSON.stringify(template)) < 51_200);
  assert.ok(
    !Object.values(resources).some((resource) =>
      /ApiGateway/.test(resource.Type),
    ),
  );
  const distribution = resources.Distribution.Properties!
    .DistributionConfig as any;
  assert.equal(
    distribution.DefaultCacheBehavior.LambdaFunctionAssociations[0].IncludeBody,
    false,
  );
  assert.equal(
    distribution.Origins[0].OriginAccessControlId.Ref,
    "OriginAccessControl",
  );
  const policy = resources.BucketPolicy.Properties!.PolicyDocument as any;
  assert.equal(
    policy.Statement[0].Condition.StringEquals["s3:if-none-match"],
    "*",
  );
  assert.equal(resources.CacheBucket.DeletionPolicy, "Retain");
  for (const resource of Object.values(resources).filter(
    (resource) => resource.Type === "AWS::Lambda::Function",
  )) {
    assert.equal(resource.Properties!.Environment, undefined);
    assert.equal((resource.Properties!.Architectures as string[])[0], "x86_64");
  }
  const code = resources.ViewerFunction.Properties!.Code as any;
  const parts = code.ZipFile["Fn::Join"][1];
  const viewerSource = parts[0] + "test-bucket" + parts[2];
  const module = { exports: {} as { handler: Function } };
  const required: string[] = [];
  runInContext(
    viewerSource,
    createContext({
      module,
      exports: module.exports,
      Buffer,
      require: (name: string) => {
        required.push(name);
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
  assert.ok(required.includes("@aws-sdk/client-s3"));
  const changed = await buildTemplate({ ...config, signedUrlTtlSeconds: 600 });
  assert.notDeepEqual(
    Object.keys(resources).filter((key) => key.startsWith("ViewerVersion")),
    Object.keys(changed.Resources).filter((key) =>
      key.startsWith("ViewerVersion"),
    ),
  );
  assert.deepEqual(
    Object.keys(resources).filter((key) => key.endsWith("Function")),
    Object.keys(changed.Resources).filter((key) => key.endsWith("Function")),
  );
});
