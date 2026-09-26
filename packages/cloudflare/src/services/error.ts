import { safeBody } from "@deploykit/core/http"

import * as Provider from "@deploykit/core/provider"
import { CloudflareApiError } from "./client.js"

export interface ErrorContext {
  readonly appId?: string
  readonly appName?: string
  readonly deploymentId?: string
}

export const toProviderError = (
  cause: unknown,
  context: ErrorContext = {}
): Provider.ProviderError =>
  cause instanceof CloudflareApiError
    ? new Provider.ProviderError({
        message: cause.message,
        operation: cause.operation,
        ...(cause.deploymentId === undefined ? {} : { deploymentId: cause.deploymentId }),
        ...(cause.requestId === undefined ? {} : { requestId: cause.requestId }),
        ...(cause.code === undefined ? {} : { code: cause.code }),
        outcome: /^(get|find|list|check)/.test(cause.operation)
          ? "observation-failed"
          : cause.statusCode !== undefined &&
              [400, 401, 403, 404, 409, 422].includes(cause.statusCode)
            ? "rejected"
            : "unknown",
        recovery: /^(get|find|list|check)/.test(cause.operation)
          ? "retry"
          : cause.statusCode !== undefined &&
              [400, 401, 403, 404, 409, 422].includes(cause.statusCode)
            ? "fix-input"
            : "reconcile",
        provider: "cloudflare",
        ...(cause.statusCode !== undefined ? { statusCode: cause.statusCode } : {}),
        ...(cause.body !== undefined ? { body: safeBody(cause.body) } : {}),
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
        ...(cause.transient === true ? { transient: true } : {}),
        ...context
      })
    : new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "cloudflare",
        ...context
      })
