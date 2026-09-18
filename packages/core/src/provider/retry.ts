/**
 * When a provider call is worth trying again, and how long to wait.
 *
 * The policy lives in core rather than in an adapter so every adapter backs
 * off the same way, and so a caller can reason about retries without knowing
 * which provider produced the failure.
 */

import { Duration, Effect, Schedule } from "effect"

/**
 * The shape a retryable failure has. Structural rather than a named error, so
 * both `ProviderError` and an adapter's own transport error satisfy it without
 * either having to know about this module.
 */
export interface RetryableFailure {
  readonly statusCode?: number | undefined
  readonly retryAfterMs?: number | undefined
}

/**
 * Whether retrying could plausibly succeed.
 *
 * A missing status means the request never got an answer: DNS, a reset
 * connection, a timeout. Those are the most retryable failures there are.
 */
export const isTransient = (error: RetryableFailure): boolean => {
  const status = error.statusCode
  if (status === undefined) return true
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

/**
 * A throttle, specifically.
 *
 * Worth separating from the rest because a 429 is the one transient failure
 * that tells you the request was rejected *before* it did anything. That makes
 * it safe to retry even an operation that is not idempotent.
 */
export const isThrottle = (error: RetryableFailure): boolean => error.statusCode === 429

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 4. */
  readonly attempts?: number
  /** First backoff step; doubles from there. Defaults to 250ms. */
  readonly baseDelay?: Duration.Input
}

/**
 * Exponential backoff with jitter, honouring Retry-After when the provider
 * sent one.
 *
 * Jitter matters when a publish uploads many files at once: without it every
 * throttled request retries on the same tick and re-throttles as a block.
 * Retry-After wins over the computed delay because it is the server saying
 * exactly how long to wait, which beats any guess.
 */
export const backoff = (options: RetryOptions = {}) =>
  Schedule.exponential(options.baseDelay ?? "250 millis", 2).pipe(
    Schedule.jittered,
    Schedule.modifyDelay((metadata: Schedule.Metadata<Duration.Duration, RetryableFailure>) =>
      Effect.succeed(
        metadata.input.retryAfterMs === undefined
          ? metadata.duration
          : Duration.millis(metadata.input.retryAfterMs)
      )
    ),
    Schedule.upTo({ times: Math.max(0, (options.attempts ?? 4) - 1) })
  )

/**
 * Retry a call that is safe to repeat: a read, or a write whose result does
 * not depend on how many times it happened.
 */
export const retryIdempotent =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, { while: isTransient, schedule: backoff(options) })

/**
 * Retry a call that is NOT safe to repeat, on a throttle only.
 *
 * A 500 from `createDeployment` is ambiguous: the deployment may exist. Trying
 * again risks a duplicate, which for a create is worse than surfacing the
 * error and letting the caller decide. A 429 carries no such doubt, because
 * the provider rejected the request before acting on it.
 */
export const retryThrottleOnly =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, { while: isThrottle, schedule: backoff(options) })
