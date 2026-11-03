# Nx cache on AWS CloudFront + S3

A self-hosted Nx remote cache deployed with [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html). Uploads pass through CloudFront directly to a private S3 bucket. Downloads redirect to short-lived presigned S3 URLs. No artifact body passes through API Gateway or Lambda.

```text
Upload:   Nx ──PUT──▶ CloudFront ──OAC-signed PUT──▶ S3
                         │
                         └─ Lambda@Edge validates headers, then returns

Download: Nx ──GET──▶ CloudFront ──Lambda@Edge──▶ 302 presigned URL
          Nx ◀────────────── artifact directly from S3
```

The edge handlers implement Nx's `GET /v1/cache/{hash}` and `PUT /v1/cache/{hash}` contract, with separate read-only and read/write tokens, repository isolation and atomic write-once uploads. Nx creates its own gzip archives; this service preserves their bytes.

**Validation status:** tests exercise the real Nx 24.0.3 native HTTP client with a 16 MiB artifact, cross-host redirects, gzip restore, misses and duplicate uploads. Handler tests and offline CloudFormation schema/bundle checks also pass. Run the live smoke tests against your deployment before relying on it in CI: local checks cannot prove CloudFront OAC forwarding and S3 conditional-write behavior on AWS.

## Deploy

Requires Node.js 24+, npm, an AWS account and deployment credentials. CDK dependencies and the lockfile are pinned. The dedicated CDK `cloudfront.experimental.EdgeFunction` construct manages Lambda@Edge functions and published versions; that construct is still in CDK’s experimental namespace.

```sh
npm ci
npm run configure -- my-monorepo
export AWS_REGION=us-east-1
export AWS_PROFILE=your-profile
aws sso login --profile "$AWS_PROFILE" # if using SSO
npm run build
# Once per AWS account/region; replace YOUR_ACCOUNT_ID:
npm run bootstrap -- aws://YOUR_ACCOUNT_ID/us-east-1
npm run plan
npm run deploy
```

The CDK app uses native `Bucket`, `Distribution`, `S3BucketOrigin.withOriginAccessControl` and `EdgeFunction` constructs. CDK synthesizes and deploys CloudFormation, including versioned edge associations and separate execution roles for signing downloads and handling upload responses. The stack is intentionally in **us-east-1**, as required by Lambda@Edge. CloudFront is global; the bucket is in us-east-1 too. First deployment and updates can take several minutes to propagate.

`configure` creates two gitignored files with mode `0600`:

- `cache.config.json`: namespaces, SHA-256 token digests and settings. Only digests enter the deployment template.
- `cache.tokens.json`: randomly generated plaintext tokens for your CI secret store. Do not commit or share this file.

The command refuses to overwrite existing files. Read the token file locally to configure your secret manager. The deployment credentials need CloudFormation, S3, CloudFront, IAM and Lambda permissions, including `iam:PassRole` and Lambda@Edge replication/service-linked-role permissions. They are deployment credentials, never credentials used by Nx clients.

CloudFormation holds deployment state in AWS. `cdk.out/` contains generated templates and assembly files and is gitignored. The included GitHub workflow runs checks and synthesizes the stack offline; it does not deploy or require AWS credentials. `npm run synth` emits the CDK assembly; `npm run build` also writes a standalone template to `dist/cloudformation.json`.

Earlier Alchemy deployments are not automatically adopted by this CDK app. If you deployed that version, preserve its `.alchemy/` state, deploy the CDK stack separately, switch Nx to the new endpoint, and retire the old deployment using its original configuration.

## Connect Nx

Use the `CacheUrl` from the deployment outputs:

```sh
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://example.cloudfront.net
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=your-token-from-your-secret-store
npx nx run-many -t build
```

Use the read/write token only in trusted build pipelines. Give untrusted PR jobs the read-only token, if they are allowed to read these artifacts. A read token can read **all artifacts in its repository namespace**. Never expose cache write credentials to untrusted code. Write-once behavior does not prevent a malicious writer from planting an entry first.

Missing, malformed or unrecognized credentials return `403 text/plain` for GET and `401 text/plain` for PUT, matching Nx's specified authentication responses. A recognized read-only token attempting a PUT returns `403 text/plain`. These failures never issue a download redirect. After a successful redirect, S3 itself handles download errors; an expired presigned URL or a storage authorization failure uses S3's native error format.

The Nx 24.0.3 native HTTP client follows redirects and strips the bearer token when redirecting across hosts; the automated transport test verifies this. Test other pinned Nx versions before use. The base URL has no trailing slash. No custom Nx task runner or AWS credentials are needed on clients. Nx Cloud configuration can affect remote-cache selection; verify the self-hosted endpoint is being used in your workspace.

## Configuration

Example `cache.config.json` shape (replace digests with hashes of independently generated strong tokens):

```json
{
  "repositories": [
    {
      "namespace": "my-monorepo",
      "readWriteTokenSha256": "<64 lowercase hex characters>",
      "readOnlyTokenSha256": "<64 lowercase hex characters>"
    }
  ],
  "retentionDays": 30,
  "maxArtifactBytes": 1073741824,
  "signedUrlTtlSeconds": 300
}
```

Each repository must have unique tokens and a unique namespace. The authenticated token selects the namespace; a caller cannot choose another namespace in the URL. Objects are stored at `cache/{namespace}/{hash}`. More repositories enlarge the embedded function configuration. CDK handles CloudFormation template publishing; AWS template and Lambda code-size quotas still apply.

Uploads require `Content-Length`, as specified by Nx. The default artifact limit is 1 GiB and is configurable up to 5,000,000,000 bytes, below S3's single-PUT ceiling. The service does not implement multipart uploads or resumable transfers. API Gateway's 10 MB limit does not apply. A stock Nx client may buffer archives locally even though the service does not.

For token rotation, generate a fresh random token, compute its SHA-256 digest and update the appropriate digest in `cache.config.json`, then redeploy and update the CI secret. Allow for CloudFront propagation. Previously issued S3 URLs remain usable until their expiration or the signing role's credentials expire. Old retained Lambda versions contain old token hashes; restrict administrative access to them.

## How the AWS request path works

1. A viewer-request Lambda@Edge checks authentication, the exact cache path, method and upload size. `IncludeBody` is **false**.
2. A `GET` is signed locally and answered with `302`, `Location` and `Cache-Control: no-store`. No S3 HEAD request is needed. S3 returns `404` for a missing artifact, which Nx treats as a cache miss. The signing role has `ListBucket` solely so S3 can distinguish missing objects from inaccessible ones; there is no listing endpoint.
3. A trusted `PUT` is rewritten to the authenticated repository's object key. The handler removes client-supplied S3 controls and bearer authorization, then sets `If-None-Match: *` and `x-amz-content-sha256: UNSIGNED-PAYLOAD`. CloudFront's OAC signs the origin request over HTTPS.
4. The OAC bucket policy grants that distribution `PutObject`; an explicit bucket-policy deny rejects any cache write without `If-None-Match: *`, including writes allowed through another IAM policy. S3 rejects an existing key atomically. A small origin-response Lambda@Edge converts S3's `412` to Nx's `409`. Neither edge function reads an artifact body.

Only authenticated GET and PUT operations are offered. Query parameters, encoded paths, arbitrary keys and other methods are rejected. There is no public bucket access, artifact recompression, database, VPC, NAT Gateway or always-running compute. SSE-S3 encryption avoids per-request KMS charges.

## Verify

```sh
npm run check
npm run build

# After deployment: performs real writes and downloads, using local tokens.
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://example.cloudfront.net
npm run smoke
```

The live smoke test verifies a 16 MiB random artifact, a direct S3 download, automatic cross-host redirects, misses, read-only writes, duplicate writes and concurrent first writes. It leaves two objects for lifecycle expiration. It consumes storage, requests and applicable transfer bandwidth.

Also verify a real Nx task in your own workspace: run a cacheable task with the writer token, remove only its local cache/output, then repeat using the read-only token. Confirm Nx restores the result remotely without running the task. An HTTP smoke test alone does not establish compatibility with every Nx release.

## Costs and tradeoffs

- Lambda@Edge executes for authorization and small responses; it does not run for the artifact transfer duration. There is an additional origin-response invocation per forwarded upload.
- S3 charges for storage, PUT/GET requests and applicable egress. Downloads to external CI and laptops are not inherently free. Same-region AWS consumers can avoid S3 data-transfer charges; private-subnet runners should use an S3 gateway endpoint to avoid NAT processing fees.
- Uploads still use CloudFront's data path and its applicable request/transfer pricing. Downloads bypass CloudFront, so they receive no CDN caching benefit and do not incur CloudFront artifact-download charges.
- Presigned URLs are bearer capabilities. Do not log them. Keep application logs free of tokens, headers and URLs. AWS service-level logs can have separate retention/charges.
- The bucket expires artifacts after the configured age from creation, not last access. This is a disposable cache, not an artifact registry.

## Removal

```sh
export AWS_REGION=us-east-1
npm run destroy
```

The distribution, OAC and bucket policy are removed. **The bucket, edge functions, published versions, execution roles and their inline IAM policies are deliberately retained**, because cache data should not be silently deleted and AWS does not allow deleting Lambda@Edge versions while replicas exist. Function CloudWatch logs may also remain in execution regions. After detaching the distribution and waiting for replicas to disappear, remove these resources manually if desired. Save deployment outputs before destroying. Retained buckets incur storage charges until empty or deleted; their lifecycle rules continue expiring artifacts. Recreating a stack creates new resources rather than adopting the retained ones.

## References

- [Nx self-hosted cache contract](https://nx.dev/docs/kb/self-hosted-caching)
- [CloudFront S3 origins and PUT forwarding](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorS3Origin.html)
- [CloudFront origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [CDK EdgeFunction construct](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.experimental.EdgeFunction.html)
- [Lambda@Edge restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)

## License

MIT
