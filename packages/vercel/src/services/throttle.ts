import { Clock, Effect, Semaphore } from "effect"
import * as Telemetry from "@deploykit/core/telemetry"
import { VercelApiError } from "./client.js"

export interface UploadThrottleLimits {
  readonly concurrency: number
  readonly intervalMs: number
}

export const uploadThrottlePresets = {
  conservative: { concurrency: 4, intervalMs: 250 },
  balanced: { concurrency: 8, intervalMs: 100 },
  fast: { concurrency: 16, intervalMs: 0 }
} as const satisfies Record<string, UploadThrottleLimits>

export type UploadThrottle = keyof typeof uploadThrottlePresets | UploadThrottleLimits

/** One client shares upload permits, pacing and server cooldown across its callers. */
export const makeUploadThrottle = (option: UploadThrottle | undefined) => {
  const limits = typeof option === "string" ? uploadThrottlePresets[option] : option
  const valid =
    option === undefined ||
    (limits != null &&
      Number.isSafeInteger(limits.concurrency) &&
      limits.concurrency >= 1 &&
      limits.concurrency <= 32 &&
      Number.isSafeInteger(limits.intervalMs) &&
      limits.intervalMs >= 0 &&
      limits.intervalMs <= 60000)
  const uploads = Semaphore.makeUnsafe(valid ? (limits?.concurrency ?? 32) : 1)
  const starts = Semaphore.makeUnsafe(1)
  let nextStart = 0
  let cooldownUntil = 0

  const validate = valid
    ? Effect.void
    : Effect.fail(
        new VercelApiError({
          operation: "uploadFile",
          code: "invalid_upload_throttle",
          message: "Upload throttle needs concurrency 1–32 and intervalMs 0–60000"
        })
      )

  const pace = starts.withPermits(1)(
    Effect.gen(function* () {
      let now = yield* Clock.currentTimeMillis
      while (Math.max(nextStart, cooldownUntil) > now) {
        yield* Telemetry.observe(
          "vercel",
          "uploadThrottle.wait",
          Effect.sleep(Math.max(nextStart, cooldownUntil) - now)
        )
        now = yield* Clock.currentTimeMillis
      }
      nextStart = now + (limits?.intervalMs ?? 0)
    })
  )

  return {
    validate,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      option === undefined ? effect : uploads.withPermits(1)(Effect.andThen(pace, effect)),
    cooldown: (delayMs: number) =>
      Effect.gen(function* () {
        if (option === undefined) return
        const now = yield* Clock.currentTimeMillis
        cooldownUntil = Math.max(cooldownUntil, now + delayMs)
      })
  }
}
