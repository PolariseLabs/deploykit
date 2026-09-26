import { safeBody } from "@deploykit/core/http"

import * as Provider from "@deploykit/core/provider"
import { VercelApiError } from "./client.js"

export interface ErrorContext {
  readonly appId?: string
  readonly appName?: string
  readonly deploymentId?: string
}

export const toProviderError = (
  cause: unknown,
  context: ErrorContext = {}
): Provider.ProviderError => {
  if (!(cause instanceof VercelApiError))
    return new Provider.ProviderError({
      message: cause instanceof Error ? cause.message : "Unknown error",
      provider: "vercel",
      ...context
    })

  const observation = /^(get|find|list|check)/.test(cause.operation)
  const accessRejected =
    cause.operation === "setProjectAccess" &&
    cause.statusCode === 428 &&
    cause.code === "invalid_password_protection"
  const rejected =
    accessRejected ||
    (cause.statusCode !== undefined && [400, 401, 403, 404, 409, 422].includes(cause.statusCode))

  return new Provider.ProviderError({
    message: accessRejected
      ? "Vercel rejected password protection; check the project's plan and access settings"
      : cause.message,
    operation: cause.operation,
    ...(cause.deploymentId === undefined ? {} : { deploymentId: cause.deploymentId }),
    ...(cause.requestId === undefined ? {} : { requestId: cause.requestId }),
    ...(cause.code === undefined ? {} : { code: cause.code }),
    outcome: observation ? "observation-failed" : rejected ? "rejected" : "unknown",
    recovery: observation ? "retry" : rejected ? "fix-input" : "reconcile",
    provider: "vercel",
    ...(cause.statusCode !== undefined ? { statusCode: cause.statusCode } : {}),
    ...(cause.body !== undefined ? { body: safeBody(cause.body) } : {}),
    ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
    ...context
  })
}
