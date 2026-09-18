/** Failures a calling SaaS can reason about. Adapters map their raw HTTP and SDK errors into these. */

import { Schema } from "effect"

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  message: Schema.String
}) {}

/**
 * A provider call failed.
 *
 * The transport fields are not decoration. A caller cannot decide whether to
 * retry without the status, and `message` alone throws away everything the
 * provider said: the body usually carries the only actionable detail, and
 * Retry-After is the provider telling you exactly how long to wait.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  provider: Schema.String,
  appId: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
  deploymentId: Schema.optional(Schema.String),
  /** HTTP status, when the failure came from a response rather than the wire. */
  statusCode: Schema.optional(Schema.Number),
  /** Response body, truncated by the adapter. The actionable part is usually here. */
  body: Schema.optional(Schema.String),
  /** Milliseconds the provider asked us to wait, from Retry-After. */
  retryAfterMs: Schema.optional(Schema.Number),
  /** The adapter knows this is worth retrying even if the status does not say so. */
  transient: Schema.optional(Schema.Boolean)
}) {}
