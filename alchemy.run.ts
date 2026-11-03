import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { loadConfig } from "./src/config.ts";
import { buildTemplate } from "./src/infra/template.ts";

export default Alchemy.Stack(
  "NxCacheAwsCloudfrontS3",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // Lambda@Edge functions must be created in us-east-1. All resources in this
    // stack deliberately share that region; fail before provisioning elsewhere.
    if (process.env.AWS_REGION !== "us-east-1") {
      return yield* Effect.die(
        new Error("Set AWS_REGION=us-east-1 for Lambda@Edge"),
      );
    }
    const template = yield* Effect.promise(() => buildTemplate(loadConfig()));
    const stack = yield* AWS.CloudFormation.Stack("Cache", {
      templateBody: JSON.stringify(template),
      capabilities: ["CAPABILITY_IAM"],
      tags: { Application: "nx-cache-aws-cloudfront-s3" },
    });
    return { outputs: stack.outputs };
  }),
);
