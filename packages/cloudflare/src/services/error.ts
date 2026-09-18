/**
 * One place that turns a CloudflareApiError into a ProviderError, carrying the
 * status, body and any Retry-After across so a caller can classify it the same
 * way it classifies a Vercel failure.
 */

import * as Provider from "@deploykit/core/provider"
import { CloudflareApiError } from "./client.js"

export interface ErrorContext {
  readonly appId?: string
  readonly appName?: string
  readonly deploymentId?: string
}

export const toProviderError = (
  cause: CloudflareApiError | unknown,
  context: ErrorContext = {}
): Provider.ProviderError =>
  cause instanceof CloudflareApiError
    ? new Provider.ProviderError({
        message: cause.message,
        provider: "cloudflare",
        ...(cause.statusCode !== undefined ? { statusCode: cause.statusCode } : {}),
        ...(cause.body !== undefined ? { body: cause.body } : {}),
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
        ...context
      })
    : new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "cloudflare",
        ...context
      })
