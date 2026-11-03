import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server port");
  return address.port;
}

test(
  "Nx 24 native client restores >10 MB through a cross-host redirect without forwarding its bearer token",
  { timeout: 30_000 },
  async () => {
    // Exercise the actual Nx Rust HTTP client, gzip writer and archive reader.
    // The local servers stand in for the public endpoint and private S3 download.
    const require = createRequire(import.meta.url);
    const { HttpRemoteCache } =
      require("nx/src/native") as typeof import("nx/src/native");
    const archives = new Map<string, Buffer>();
    let leakedAuthorization: string | undefined;
    let uploadBytes = 0;
    const objectStore = createServer((request, response) => {
      leakedAuthorization = request.headers.authorization;
      const body = archives.get(request.url!);
      response.writeHead(body ? 200 : 404, {
        "Content-Type": "application/octet-stream",
      });
      response.end(body);
    });
    const objectPort = await listen(objectStore);
    const endpoint = createServer(async (request, response) => {
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const key = request.url!;
        if (archives.has(key)) {
          response.writeHead(409);
          response.end();
          return;
        }
        const body = Buffer.concat(chunks);
        uploadBytes = body.length;
        archives.set(key, body);
        response.writeHead(200);
        response.end();
      } else {
        response.writeHead(302, {
          Location: `http://localhost:${objectPort}${request.url}`,
          "Cache-Control": "no-store",
        });
        response.end();
      }
    });
    const endpointPort = await listen(endpoint);
    const directory = await mkdtemp(join(tmpdir(), "nx-cache-client-"));
    const oldUrl = process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER;
    const oldToken = process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN;
    try {
      process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER = `http://127.0.0.1:${endpointPort}`;
      process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN =
        "test-token-only-".repeat(4);
      const client = new HttpRemoteCache();
      const source = join(directory, "source");
      const destination = join(directory, "restored");
      const hash = "123456789";
      await mkdir(join(source, hash), { recursive: true });
      await mkdir(destination);
      const content = randomBytes(16 * 1024 ** 2);
      await writeFile(join(source, hash, "artifact.bin"), content);
      assert.equal(
        await client.store(hash, source, "cached terminal output", 0),
        true,
      );
      assert.ok(uploadBytes > 10 * 1024 ** 2);
      const result = await client.retrieve(hash, destination);
      assert.ok(result);
      assert.equal(result.terminalOutput, "cached terminal output");
      assert.deepEqual(
        await readFile(join(destination, hash, "artifact.bin")),
        content,
      );
      assert.equal(leakedAuthorization, undefined);
      assert.equal(await client.store(hash, source, "duplicate", 0), false);
      assert.equal(await client.retrieve("missing", destination), null);
    } finally {
      if (oldUrl === undefined)
        delete process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER;
      else process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER = oldUrl;
      if (oldToken === undefined)
        delete process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN;
      else process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = oldToken;
      endpoint.closeAllConnections();
      objectStore.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => endpoint.close(() => resolve())),
        new Promise<void>((resolve) => objectStore.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
