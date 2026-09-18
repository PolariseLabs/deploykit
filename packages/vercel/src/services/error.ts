/**
 * One place that turns a VercelApiError into a ProviderError.
 *
 * Every call site used to do `cause instanceof Error ? cause.message :
 * "Unknown error"`, which discarded the status, the body and Retry-After.
 * Those are exactly the fields a caller needs to decide whether to retry and an
 * operator needs to know what went wrong, so they are carried across here once.
 */

import * as Provider from "@deploykit/core/provider"
import { VercelApiError } from "./client.js"

export interface ErrorContext {
  readonly appId?: string
  readonly appName?: string
  readonly deploymentId?: string
}

export const toProviderError = (
  cause: VercelApiError | unknown,
  context: ErrorContext = {}
): Provider.ProviderError =>
  cause instanceof VercelApiError
    ? new Provider.ProviderError({
        message: cause.message,
        provider: "vercel",
        ...(cause.statusCode !== undefined ? { statusCode: cause.statusCode } : {}),
        ...(cause.body !== undefined ? { body: cause.body } : {}),
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
        ...context
      })
    : new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "vercel",
        ...context
      })
