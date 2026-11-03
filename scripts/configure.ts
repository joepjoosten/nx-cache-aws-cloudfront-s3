import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { parseConfig } from "../src/config.ts";

const namespace = process.argv[2] ?? "my-repo";
if (existsSync("cache.config.json") || existsSync("cache.tokens.json")) {
  throw new Error(
    "Configuration already exists; edit it explicitly to rotate or add tokens",
  );
}
const readWriteToken = randomBytes(32).toString("hex");
const readOnlyToken = randomBytes(32).toString("hex");
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const config = parseConfig({
  repositories: [
    {
      namespace,
      readWriteTokenSha256: hash(readWriteToken),
      readOnlyTokenSha256: hash(readOnlyToken),
    },
  ],
});
// Exclusive writes prevent accidentally rotating an existing installation.
writeFileSync(
  "cache.tokens.json",
  JSON.stringify({ namespace, readWriteToken, readOnlyToken }, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
writeFileSync("cache.config.json", JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  "Created cache.config.json (hashes) and cache.tokens.json (private tokens). Both are gitignored.",
);
