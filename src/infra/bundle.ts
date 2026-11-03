import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { CacheConfig } from "../config.ts";

export const BUCKET_PLACEHOLDER = "NX_CACHE_BUCKET_PLACEHOLDER";
export interface EdgeBundles {
  viewer: string;
  response: string;
}

async function bundle(
  entry: string,
  define?: Record<string, string>,
): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    platform: "node",
    target: "node22",
    format: "cjs",
    bundle: true,
    minify: true,
    write: false,
    // Node's Lambda runtime includes AWS SDK v3. Inline bundles avoid a
    // separate code asset bucket; only token digests enter the template.
    external: ["@aws-sdk/*"],
    define,
  });
  return result.outputFiles[0].text;
}

export async function bundleEdgeHandlers(
  config: CacheConfig,
): Promise<EdgeBundles> {
  const [viewer, response] = await Promise.all([
    bundle("src/edge/entry.ts", {
      __EDGE_CONFIG__: JSON.stringify({
        ...config,
        bucketName: BUCKET_PLACEHOLDER,
        region: "us-east-1",
      }),
    }),
    bundle("src/edge/origin-response.ts"),
  ]);
  if (viewer.split(BUCKET_PLACEHOLDER).length !== 2)
    throw new Error("Expected exactly one bucket substitution");
  return { viewer, response };
}
