import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const base = process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER;
if (!base || new URL(base).protocol !== "https:")
  throw new Error(
    "Set NX_SELF_HOSTED_REMOTE_CACHE_SERVER to the deployed HTTPS URL",
  );
const tokens = JSON.parse(
  readFileSync(process.env.CACHE_TOKENS ?? "cache.tokens.json", "utf8"),
);
const key = `smoke-${randomUUID()}`;
const url = `${base.replace(/\/$/, "")}/v1/cache/${key}`;
const payload = randomBytes(16 * 1024 ** 2);
const hash = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/octet-stream",
});
const request = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });

for (const [method, status] of [
  ["GET", 403],
  ["PUT", 401],
] as const) {
  for (const auth of [undefined, headers("invalid-token-".repeat(4))]) {
    const result = await request(url, {
      method,
      headers: auth,
      ...(method === "PUT" ? { body: payload } : {}),
      redirect: "manual",
    });
    assert.equal(result.status, status);
    assert.equal(result.headers.get("content-type"), "text/plain");
    assert.equal(result.headers.get("location"), null);
  }
}
assert.equal(
  (await request(url, { headers: headers(tokens.readOnlyToken) })).status,
  404,
);
assert.equal(
  (
    await request(url, {
      method: "PUT",
      headers: headers(tokens.readOnlyToken),
      body: payload,
    })
  ).status,
  403,
);
const upload = await request(url, {
  method: "PUT",
  headers: headers(tokens.readWriteToken),
  body: payload,
});
assert.equal(
  upload.status,
  200,
  `Upload failed with HTTP ${upload.status}; inspect AWS logs`,
);
const redirect = await request(url, {
  headers: headers(tokens.readOnlyToken),
  redirect: "manual",
});
assert.equal(redirect.status, 302);
assert.equal(redirect.headers.get("cache-control"), "no-store");
const target = new URL(redirect.headers.get("location")!);
assert.equal(target.hostname.endsWith(".s3.us-east-1.amazonaws.com"), true);
// Fetch S3 without the Nx bearer header; also exercise automatic cross-host redirects below.
const download = await request(target.toString());
assert.equal(download.status, 200);
assert.equal(hash(new Uint8Array(await download.arrayBuffer())), hash(payload));
assert.equal(
  (await request(url, { headers: headers(tokens.readOnlyToken) })).status,
  200,
);
const replacement = randomBytes(1024);
assert.equal(
  (
    await request(url, {
      method: "PUT",
      headers: headers(tokens.readWriteToken),
      body: replacement,
    })
  ).status,
  409,
);
const after = await request(url, { headers: headers(tokens.readOnlyToken) });
assert.equal(hash(new Uint8Array(await after.arrayBuffer())), hash(payload));
// Concurrent first writes must yield exactly one stored value.
const raceUrl = `${url}-race`;
const race = await Promise.all(
  [payload, replacement].map((body) =>
    request(raceUrl, {
      method: "PUT",
      headers: headers(tokens.readWriteToken),
      body,
    }),
  ),
);
assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
console.log(
  "Passed: 16 MiB upload, direct S3 download, redirect following, read-only auth, immutable writes and concurrent uploads.",
);
console.log("Smoke objects remain in the bucket until lifecycle expiration.");
