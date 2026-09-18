/** Failures a calling SaaS can reason about. Adapters map their raw HTTP and SDK errors into these. */

import { Schema } from "effect"

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  message: Schema.String
}) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  appId: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
  deploymentId: Schema.optional(Schema.String),
  provider: Schema.String
}) {}
