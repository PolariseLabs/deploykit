/** Failures a calling SaaS can reason about. Adapters map their raw HTTP and SDK errors into these. */

import { Schema } from "effect"

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  message: Schema.String
}) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  provider: Schema.String,
  operation: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["rejected", "unknown", "observation-failed"])),
  recovery: Schema.optional(Schema.Literals(["retry", "reconcile", "fix-input"])),
  appId: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
  deploymentId: Schema.optional(Schema.String),
  /** HTTP status, when the failure came from a response rather than the wire. */
  statusCode: Schema.optional(Schema.Number),
  /** Allowlisted provider diagnostics; never raw response text. */
  body: Schema.optional(Schema.String),
  /** Milliseconds the provider asked us to wait, from Retry-After. */
  retryAfterMs: Schema.optional(Schema.Number),
  /** The adapter knows this is worth retrying even if the status does not say so. */
  transient: Schema.optional(Schema.Boolean)
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String
}) {}
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  reference: Schema.String,
  message: Schema.String
}) {}
export class IntegrityError extends Schema.TaggedError<IntegrityError>()("IntegrityError", {
  path: Schema.String,
  message: Schema.String
}) {}
export class TransferLimitError extends Schema.TaggedError<TransferLimitError>()(
  "TransferLimitError",
  { message: Schema.String }
) {}
export type TransferError = SourceError | IntegrityError | TransferLimitError | ValidationError
