import type {
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
  CloudFrontResultResponse,
} from "aws-lambda";

export async function handler(
  event: CloudFrontResponseEvent,
): Promise<CloudFrontResponseResult> {
  const { request } = event.Records[0].cf;
  const response: CloudFrontResultResponse = event.Records[0].cf.response;
  if (
    request.method === "PUT" &&
    (response.status === "412" || response.status === "409")
  ) {
    response.status = "409";
    response.statusDescription = "Conflict";
    response.body = "Cannot override an existing record";
  } else if (Number(response.status) >= 400) {
    // Origin-response events do not expose S3's XML body. Supply an Nx-compatible message.
    response.body = `Cache storage request failed (${response.status})`;
  } else {
    return response;
  }
  response.headers ??= {};
  delete response.headers["content-length"];
  delete response.headers["content-encoding"];
  delete response.headers["etag"];
  response.headers["content-type"] = [
    { key: "Content-Type", value: "text/plain" },
  ];
  response.headers["cache-control"] = [
    { key: "Cache-Control", value: "no-store" },
  ];
  return response;
}
