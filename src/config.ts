import { readFileSync } from "node:fs";

export interface Repository {
  namespace: string;
  readWriteTokenSha256: string;
  readOnlyTokenSha256: string;
}

export interface CacheConfig {
  bucketRegion: string;
  repositories: Repository[];
  retentionDays: number;
  maxArtifactBytes: number;
  signedUrlTtlSeconds: number;
}

export interface EdgeConfig extends CacheConfig {
  bucketName: string;
  region: string;
}

export function parseConfig(value: unknown): CacheConfig {
  if (!value || typeof value !== "object")
    throw new Error("Expected a cache config object");
  const input = value as Record<string, unknown>;
  const bucketRegion = input.bucketRegion ?? "us-east-1";
  // CloudFront/Lambda@Edge and this app use the commercial AWS partition.
  // Validate the name shape, leaving region availability/opt-in to AWS.
  if (
    typeof bucketRegion !== "string" ||
    !/^(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/.test(
      bucketRegion,
    )
  ) {
    throw new Error(
      "bucketRegion must be a commercial AWS region name, e.g. eu-west-1",
    );
  }
  if (!Array.isArray(input.repositories) || !input.repositories.length) {
    throw new Error("Configure at least one repository");
  }
  const namespaces = new Set<string>();
  const tokens = new Set<string>();
  const repositories = input.repositories.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid repository config");
    const repo = entry as Repository;
    if (
      typeof repo.namespace !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(repo.namespace)
    ) {
      throw new Error(
        "Repository namespace must match [a-z0-9][a-z0-9_-]{0,62}",
      );
    }
    if (namespaces.has(repo.namespace))
      throw new Error("Duplicate repository namespace");
    namespaces.add(repo.namespace);
    for (const digest of [
      repo.readWriteTokenSha256,
      repo.readOnlyTokenSha256,
    ]) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(
          "Tokens must be configured as lowercase SHA-256 digests",
        );
      }
      if (tokens.has(digest))
        throw new Error("Each token must have a unique digest");
      tokens.add(digest);
    }
    return {
      namespace: repo.namespace,
      readWriteTokenSha256: repo.readWriteTokenSha256,
      readOnlyTokenSha256: repo.readOnlyTokenSha256,
    };
  });
  function integer(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = input[key] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  return {
    bucketRegion,
    repositories,
    retentionDays: integer("retentionDays", 30, 1, 365),
    maxArtifactBytes: integer("maxArtifactBytes", 1024 ** 3, 1, 5_000_000_000),
    signedUrlTtlSeconds: integer("signedUrlTtlSeconds", 300, 30, 3600),
  };
}

export function loadConfig(
  path = process.env.CACHE_CONFIG ?? "cache.config.json",
): CacheConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
