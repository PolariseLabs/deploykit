import type { DeploymentFailedError, DeploymentTimeoutError } from "../platform/errors.js"
import type { Failure } from "./failure.js"
import { isTransient } from "./retry.js"

/**
 * What a caller should do next about a failure.
 *
 * - `retry`: nothing was created; running the same call again is safe.
 * - `reconcile`: the provider may have acted; look it up (`reconcileDeployment`) before retrying.
 * - `wait`: still in progress; keep polling the same deployment.
 * - `fix-input`: the request or content is wrong; retrying unchanged fails again.
 * - `unsupported`: this provider cannot do it; check `capabilities` before offering it.
 */
export type Recovery = "retry" | "reconcile" | "wait" | "fix-input" | "unsupported"

export type RecoverableError = Failure | DeploymentFailedError | DeploymentTimeoutError

export const recoveryOf = (error: RecoverableError): Recovery => {
  switch (error._tag) {
    case "ProviderError":
      if (error.recovery !== undefined) return error.recovery
      if (error.outcome === "unknown") return "reconcile"
      return isTransient(error) ? "retry" : "fix-input"
    case "SourceError":
    case "UploadError":
      return "retry"
    case "DeploymentTimeoutError":
      return "wait"
    case "ValidationError":
    case "IntegrityError":
    case "TransferLimitError":
    case "DeploymentFailedError":
      return "fix-input"
    case "UnsupportedError":
      return "unsupported"
    default: {
      const _exhaustive: never = error
      return _exhaustive
    }
  }
}
