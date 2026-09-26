import * as Telemetry from "../telemetry.js"
/** Retries require repeatable operations or explicit rejection evidence. */

import { Duration, Effect, Schedule } from "effect"

export interface RetryableFailure {
  readonly statusCode?: number | undefined
  readonly retryAfterMs?: number | undefined

  readonly transient?: boolean | undefined
  readonly rejected?: boolean | undefined
}

export const isTransient = (error: RetryableFailure): boolean => {
  if (error.transient === true) return true
  const status = error.statusCode
  if (status === undefined) return true
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

export const isThrottle = (error: RetryableFailure): boolean => error.statusCode === 429

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 4. */
  readonly attempts?: number
  /** First backoff step; doubles from there. Defaults to 250ms. */
  readonly baseDelay?: Duration.Input
}

export const backoff = (options: RetryOptions = {}) =>
  Schedule.exponential(options.baseDelay ?? "250 millis", 2).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: Math.max(0, (options.attempts ?? 4) - 1) }),
    Schedule.modifyDelay((metadata: Schedule.Metadata<Duration.Duration, RetryableFailure>) =>
      Effect.gen(function* () {
        const delay =
          metadata.input.retryAfterMs === undefined
            ? metadata.duration
            : Duration.millis(metadata.input.retryAfterMs)
        yield* Telemetry.emit({
          kind: "retry.scheduled",
          attempt: metadata.attempt,
          delayMs: Duration.toMillis(delay),
          ...(metadata.input.statusCode === undefined
            ? {}
            : { statusCode: metadata.input.statusCode })
        })
        return delay
      })
    )
  )

export const retryIdempotent =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, { while: isTransient, schedule: backoff(options) })

export const retryThrottleOnly =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, {
      while: error => isThrottle(error) && error.rejected === true,
      schedule: backoff(options)
    })
