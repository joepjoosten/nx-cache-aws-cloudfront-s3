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
  ]) {
    assert.throws(() => parseConfig(value));
  }
});
