import { createHash, timingSafeEqual } from "node:crypto";
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
} from "aws-lambda";
import type { EdgeConfig } from "../config.ts";

export type SignDownload = (key: string) => Promise<string>;

function text(status: number, body: string): CloudFrontResultResponse {
  return {
    status: String(status),
    body,
    headers: {
      "content-type": [{ key: "Content-Type", value: "text/plain" }],
      "cache-control": [{ key: "Cache-Control", value: "no-store" }],
    },
  };
}

function matches(digest: Buffer, expected: string): boolean {
  return timingSafeEqual(digest, Buffer.from(expected, "hex"));
}

/** No request body is included in this Lambda@Edge event. */
export function createViewerHandler(
  config: EdgeConfig,
  signDownload: SignDownload,
) {
  return async (
    event: CloudFrontRequestEvent,
  ): Promise<CloudFrontRequest | CloudFrontResultResponse> => {
    const request = event.Records[0].cf.request;
    const authorization = request.headers.authorization;
    if (
      authorization?.length !== 1 ||
      !/^Bearer [!-~]{32,512}$/.test(authorization[0].value)
    ) {
      return text(401, "Missing or invalid authentication token");
    }
    const digest = createHash("sha256")
      .update(authorization[0].value.slice(7))
      .digest();
    let namespace: string | undefined;
    let canWrite = false;
    for (const repository of config.repositories) {
      const writer = matches(digest, repository.readWriteTokenSha256);
      const reader = matches(digest, repository.readOnlyTokenSha256);
      if (writer || reader) {
        namespace = repository.namespace;
        canWrite = writer;
      }
    }
    if (!namespace) return text(401, "Missing or invalid authentication token");
    const match = /^\/v1\/cache\/([A-Za-z0-9_-]{1,255})$/.exec(request.uri);
    // Never forward arbitrary S3 operations, encoded paths, or query parameters.
    if (!match || request.querystring) return text(404, "Not found");
    if (request.method !== "GET" && request.method !== "PUT") {
      return text(405, "Only GET and PUT are supported");
    }
    const key = `cache/${namespace}/${match[1]}`;
    if (request.method === "GET") {
      try {
        // Signing is local. S3 itself returns 404 for a missing object; no HEAD round trip.
        return {
          status: "302",
          headers: {
            location: [{ key: "Location", value: await signDownload(key) }],
            "cache-control": [{ key: "Cache-Control", value: "no-store" }],
          },
        };
      } catch {
        // Do not log bearer tokens or presigned URLs.
        return text(503, "Unable to authorize cache download");
      }
    }
    if (!canWrite) return text(403, "Access forbidden (read-only token)");
    const lengths = request.headers["content-length"];
    if (lengths?.length !== 1 || !/^[1-9][0-9]*$/.test(lengths[0].value)) {
      return text(411, "A positive Content-Length is required");
    }
    const length = Number(lengths[0].value);
    if (!Number.isSafeInteger(length) || length > config.maxArtifactBytes) {
      return text(413, "Cache artifact exceeds the configured size limit");
    }
    // Keep CloudFront's read-only headers. Discard all client-controlled S3
    // metadata, authorization, ACL, encryption, tagging and conditional headers.
    const preserved = new Set([
      "host",
      "content-length",
      "transfer-encoding",
      "via",
      "cdn-loop",
    ]);
    for (const header of Object.keys(request.headers)) {
      if (!preserved.has(header)) delete request.headers[header];
    }
    request.headers["content-type"] = [
      { key: "Content-Type", value: "application/octet-stream" },
    ];
    request.headers["if-none-match"] = [{ key: "If-None-Match", value: "*" }];
    request.headers["x-amz-content-sha256"] = [
      { key: "X-Amz-Content-Sha256", value: "UNSIGNED-PAYLOAD" },
    ];
    request.uri = `/${key}`;
    return request;
  };
}
