/** Poll serving readiness separately from provider status and activation. */

import { Clock, Effect, Schedule, Schema } from "effect"

export class NotServingError extends Schema.TaggedError<NotServingError>()("NotServingError", {
  url: Schema.String,
  /** The last status seen, or absent if the request never got an answer. */
  status: Schema.optional(Schema.Number),
  waitedMs: Schema.Number
}) {}

export interface ServingOptions {
  /** Defaults to accepting 2xx responses. */
  readonly accept?: (status: number) => boolean
  /** Poll spacing and optional attempt limit; the overall deadline still applies. */
  readonly schedule?: Schedule.Schedule<unknown>
  /** Overall deadline, including requests and cleanup; defaults to 60,000 ms. */
  readonly timeoutMs?: number
  /** Custom transports must honour the supplied abort signal. */
  readonly fetch?: typeof globalThis.fetch
}

const isSuccess = (status: number) => status >= 200 && status < 300
const defaultSchedule = Schedule.spaced("500 millis")

/** Poll without following redirects, which could otherwise mistake a login page for success. */
export const waitUntilServing = (
  url: string,
  options: ServingOptions = {}
): Effect.Effect<number, NotServingError> =>
  Effect.gen(function* () {
    const accept = options.accept ?? isSuccess
    const doFetch = options.fetch ?? globalThis.fetch
    const started = yield* Clock.currentTimeMillis
    const timeoutMs = options.timeoutMs ?? 60000
    let seen: number | undefined
    const failure = Effect.gen(function* () {
      return new NotServingError({
        url,
        ...(seen === undefined ? {} : { status: seen }),
        waitedMs: (yield* Clock.currentTimeMillis) - started
      })
    }).pipe(Effect.flatMap(Effect.fail))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return yield* failure

    const probe = Effect.tryPromise(async signal => {
      const response = await doFetch(url, { redirect: "manual", signal })
      seen = response.status
      await response.body?.cancel().catch(() => undefined)
      return response.status
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch(() => Effect.void)
    )

    return yield* probe.pipe(
      Effect.repeat({
        until: status => status !== undefined && accept(status),
        schedule: options.schedule ?? defaultSchedule
      }),
      Effect.flatMap(status =>
        status !== undefined && accept(status) ? Effect.succeed(status) : failure
      ),
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () => failure)
    )
  })
