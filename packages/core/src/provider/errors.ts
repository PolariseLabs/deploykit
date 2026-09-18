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
  retryAfterMs: Schema.optional(Schema.Number)
}) {}

/**
 * Whether retrying could plausibly succeed. Lives beside the error rather than
 * in an adapter so every adapter classifies the same way, and so a caller can
 * ask without knowing which provider produced it.
 */
export const isTransient = (error: ProviderError): boolean => {
  const status = error.statusCode
  if (status !== undefined) {
    return status === 408 || status === 429 || (status >= 500 && status < 600)
  }
  // No status means the request never got an answer: DNS, connection reset,
  // timeout. Those are the most retryable failures there are.
  return true
}
