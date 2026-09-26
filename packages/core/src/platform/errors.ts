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

/** The provider finished the deployment and reports it failed, e.g. a rejected build. */
export class DeploymentFailedError extends Schema.TaggedError<DeploymentFailedError>()(
  "DeploymentFailedError",
  {
    deploymentId: Schema.String,
    /** The provider's reason, when it gives one. */
    reason: Schema.optional(Schema.String)
  }
) {}
