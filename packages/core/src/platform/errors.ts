import { Schema } from "effect"
import { deploymentStatus } from "../provider/provider.ts"

export class AppStoreError extends Schema.TaggedError<AppStoreError>()("AppStoreError", {
  message: Schema.String,
  externalId: Schema.optional(Schema.String)
}) {}

/**
 * A deployment was still moving when we stopped waiting. Not a provider
 * failure: the provider is fine, the build is just slow. Carries the last
 * status seen so a caller can decide whether to keep waiting or give up.
 */
export class DeploymentTimeoutError extends Schema.TaggedError<DeploymentTimeoutError>()(
  "DeploymentTimeoutError",
  {
    deploymentId: Schema.String,
    lastStatus: deploymentStatus
  }
) {}
