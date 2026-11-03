import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";

const repository = {
  namespace: "my-repo",
  readWriteTokenSha256: "a".repeat(64),
  readOnlyTokenSha256: "b".repeat(64),
};
test("configuration validates namespaces, unique digests and bounded resource settings", () => {
  assert.equal(parseConfig({ repositories: [repository] }).retentionDays, 30);
  assert.equal(
    parseConfig({ repositories: [repository] }).bucketRegion,
    "us-east-1",
  );
  assert.equal(
    parseConfig({ repositories: [repository], bucketRegion: "eu-west-1" })
      .bucketRegion,
    "eu-west-1",
  );
  for (const value of [
    null,
    {},
    { repositories: [] },
    { repositories: [{ ...repository, namespace: "../escape" }] },
    {
      repositories: [
        { ...repository, readOnlyTokenSha256: repository.readWriteTokenSha256 },
      ],
    },
    { repositories: [repository, repository] },
    { repositories: [repository], retentionDays: 0 },
    { repositories: [repository], maxArtifactBytes: 5_000_000_001 },
    { repositories: [repository], signedUrlTtlSeconds: 0 },
    ...[
      "",
      "EU-WEST-1",
      "../us-east-1",
      "eu-west-0",
      "us-gov-west-1",
      "cn-north-1",
      42,
    ].map((bucketRegion) => ({ repositories: [repository], bucketRegion })),
  ]) {
    assert.throws(() => parseConfig(value));
  }
});
