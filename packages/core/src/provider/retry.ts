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

/**
 * Longest wait between attempts. Without Retry-After the backoff is capped here;
 * a 429 asking for longer is handed back to the caller rather than slept through.
 */
const maxDelay = Duration.seconds(10)

export const backoff = (options: RetryOptions = {}) =>
  Schedule.exponential(options.baseDelay ?? "250 millis", 2).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: Math.max(0, (options.attempts ?? 4) - 1) }),
    Schedule.modifyDelay((metadata: Schedule.Metadata<Duration.Duration, RetryableFailure>) =>
      Effect.gen(function* () {
        const delay =
          metadata.input.retryAfterMs === undefined
            ? Duration.min(metadata.duration, maxDelay)
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

/** A 429 short enough to wait out inside the caller's deadline. */
const briefThrottle = (error: RetryableFailure) =>
  isThrottle(error) && (error.retryAfterMs ?? 0) <= Duration.toMillis(maxDelay)

/**
 * Retries short 429s without a count, waiting as long as the provider asked or,
 * without Retry-After, doubling from `baseDelay` up to `maxDelay`.
 * The announcement lives in `while`, which only runs when a retry will actually
 * happen; a schedule step would also run for the final failure handed back.
 */
const retryBriefThrottles =
  (options: RetryOptions) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const baseMs = Duration.toMillis(Duration.fromInputUnsafe(options.baseDelay ?? "250 millis"))
      const delayMs = (error: RetryableFailure, attempt: number) =>
        error.retryAfterMs ?? Math.min(baseMs * 2 ** (attempt - 1), Duration.toMillis(maxDelay))
      let attempt = 0
      return Effect.retry(effect, {
        while: (error: E) =>
          briefThrottle(error)
            ? Telemetry.emit({
                kind: "retry.scheduled",
                attempt: ++attempt,
                delayMs: delayMs(error, attempt),
                statusCode: 429
              }).pipe(Effect.as(true))
            : Effect.succeed(false),
        schedule: Schedule.forever.pipe(
          Schedule.modifyDelay((metadata: Schedule.Metadata<number, RetryableFailure>) =>
            Effect.succeed(Duration.millis(delayMs(metadata.input, metadata.attempt)))
          )
        )
      })
    })

/**
 * Retries idempotent calls on transient failures, up to `attempts`.
 *
 * A short 429 does not use up an attempt: the provider has said it did nothing
 * and when to come back, so giving up early would fail a deploy for no reason.
 * Those retries are bounded by the deadline adapters put around every request
 * (`timeoutMs`). `attempts: 1` still means no retries at all.
 */
export const retryIdempotent =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(options.attempts === 1 ? effect : retryBriefThrottles(options)(effect), {
      while: isTransient,
      schedule: backoff(options)
    })

export const retryThrottleOnly =
  (options: RetryOptions = {}) =>
  <A, E extends RetryableFailure, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, {
      while: error => isThrottle(error) && error.rejected === true,
      schedule: backoff(options)
    })
