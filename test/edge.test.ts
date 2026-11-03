import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResponseEvent,
  CloudFrontResultResponse,
} from "aws-lambda";
import { parseConfig, type EdgeConfig } from "../src/config.ts";
import { createViewerHandler } from "../src/edge/viewer.ts";
import { handler as originResponse } from "../src/edge/origin-response.ts";

const writer = "trusted-writer-token-".repeat(3);
const reader = "untrusted-reader-token-".repeat(3);
const otherWriter = "another-repo-writer-".repeat(3);
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
export const config: EdgeConfig = {
  ...parseConfig({
    repositories: [
      {
        namespace: "repo-a",
        readWriteTokenSha256: sha(writer),
        readOnlyTokenSha256: sha(reader),
      },
      {
        namespace: "repo-b",
        readWriteTokenSha256: sha(otherWriter),
        readOnlyTokenSha256: sha("another-reader"),
      },
    ],
  }),
  bucketName: "test-bucket",
  region: "us-east-1",
};

function event(
  method = "GET",
  token: string | null = writer,
  uri = "/v1/cache/12345",
): CloudFrontRequestEvent {
  const request: CloudFrontRequest = {
    clientIp: "127.0.0.1",
    method,
    uri,
    querystring: "",
    headers: {
      host: [{ key: "Host", value: "cache.example.com" }],
      ...(token
        ? {
            authorization: [{ key: "Authorization", value: `Bearer ${token}` }],
          }
        : {}),
      "content-length": [
        { key: "Content-Length", value: String(16 * 1024 ** 2) },
      ],
    },
  };
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: "cache.example.com",
            distributionId: "test",
            eventType: "viewer-request",
            requestId: "test",
          },
          request,
        },
      },
    ],
  };
}
const response = (value: unknown) => value as CloudFrontResultResponse;

test("rejects absent, malformed, duplicate and wrong bearer tokens", async () => {
  const handler = createViewerHandler(config, async () => {
    throw new Error("must not sign");
  });
  for (const token of [null, "wrong".repeat(12), "short"]) {
    assert.equal(response(await handler(event("GET", token))).status, "401");
  }
  const duplicate = event();
  duplicate.Records[0].cf.request.headers.authorization.push({
    value: `Bearer ${writer}`,
  });
  assert.equal(response(await handler(duplicate)).status, "401");
});

test("GET signs a namespace-scoped URL without inspecting or fetching the body", async () => {
  let signedKey: string | undefined;
  const handler = createViewerHandler(config, async (key) => {
    signedKey = key;
    return "https://test-bucket.s3.amazonaws.com/signed";
  });
  const result = response(await handler(event("GET", reader)));
  assert.equal(signedKey, "cache/repo-a/12345");
  assert.equal(result.status, "302");
  assert.equal(result.headers?.["cache-control"][0].value, "no-store");
  await handler(event("GET", otherWriter));
  assert.equal(signedKey, "cache/repo-b/12345");
});

test("PUT accepts >10 MB, preserves body forwarding, strips S3 controls and enforces write-once", async () => {
  const input = event("PUT");
  const headers = input.Records[0].cf.request.headers;
  headers["x-amz-acl"] = [{ value: "public-read" }];
  headers["x-amz-meta-evil"] = [{ value: "yes" }];
  headers["if-match"] = [{ value: "hostile" }];
  headers["if-none-match"] = [{ value: "hostile" }];
  headers["content-encoding"] = [{ value: "gzip" }];
  const result = (await createViewerHandler(
    config,
    async () => "unused",
  )(input)) as CloudFrontRequest;
  assert.equal(result.uri, "/cache/repo-a/12345");
  assert.equal(
    result.headers["content-length"][0].value,
    String(16 * 1024 ** 2),
  );
  assert.equal(result.body, undefined);
  assert.equal(result.headers.authorization, undefined);
  assert.equal(result.headers["x-amz-acl"], undefined);
  assert.equal(result.headers["x-amz-meta-evil"], undefined);
  assert.equal(result.headers["content-encoding"], undefined);
  assert.equal(result.headers["if-match"], undefined);
  assert.equal(result.headers["if-none-match"][0].value, "*");
  assert.equal(
    result.headers["x-amz-content-sha256"][0].value,
    "UNSIGNED-PAYLOAD",
  );
});

test("read-only PUT returns Nx-compatible 403", async () => {
  const result = response(
    await createViewerHandler(
      config,
      async () => "unused",
    )(event("PUT", reader)),
  );
  assert.equal(result.status, "403");
  assert.equal(result.headers?.["content-type"][0].value, "text/plain");
});

test("rejects arbitrary paths, encoded paths, queries and unsupported methods", async () => {
  const handler = createViewerHandler(config, async () => "unused");
  for (const path of [
    "/",
    "/v1/cache/../secret",
    "/v1/cache/%2e%2e",
    "/cache/repo-b/12345",
    "/v1/cache/123/extra",
  ]) {
    assert.equal(
      response(await handler(event("GET", writer, path))).status,
      "404",
    );
  }
  const query = event("PUT");
  query.Records[0].cf.request.querystring = "uploads";
  assert.equal(response(await handler(query)).status, "404");
  for (const method of ["HEAD", "DELETE", "POST", "PATCH", "OPTIONS"]) {
    assert.equal(response(await handler(event(method))).status, "405");
  }
});

test("rejects missing, malformed, duplicate and oversized upload lengths", async () => {
  const handler = createViewerHandler(config, async () => "unused");
  for (const length of [undefined, "0", "-1", "4.2", "1e6"]) {
    const input = event("PUT");
    if (length === undefined)
      delete input.Records[0].cf.request.headers["content-length"];
    else
      input.Records[0].cf.request.headers["content-length"] = [
        { value: length },
      ];
    assert.equal(response(await handler(input)).status, "411");
  }
  const input = event("PUT");
  input.Records[0].cf.request.headers["content-length"] = [
    { value: String(config.maxArtifactBytes + 1) },
  ];
  assert.equal(response(await handler(input)).status, "413");
});

test("signing failures return a plain 503 without leaking error details", async () => {
  const result = response(
    await createViewerHandler(config, async () => {
      throw new Error("secret");
    })(event()),
  );
  assert.equal(result.status, "503");
  assert.ok(!result.body?.includes("secret"));
});

test("origin response translates conditional conflicts and preserves successful responses", async () => {
  for (const status of ["412", "409", "403", "500", "200"]) {
    const request = event("PUT").Records[0].cf.request;
    const input: CloudFrontResponseEvent = {
      Records: [
        {
          cf: {
            config: {
              distributionDomainName: "example.com",
              distributionId: "test",
              requestId: "test",
              eventType: "origin-response",
            },
            request,
            response: {
              status,
              statusDescription: "test",
              headers: { "content-length": [{ value: "123" }] },
            },
          },
        },
      ],
    };
    const result = response(await originResponse(input));
    assert.equal(result.status, status === "412" ? "409" : status);
    if (status !== "200") {
      assert.equal(result.headers?.["content-type"][0].value, "text/plain");
      assert.equal(result.headers?.["content-length"], undefined);
    }
  }
});
