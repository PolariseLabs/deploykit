/**
 * Waiting for a deployment's URL to actually answer.
 *
 * Deliberately separate from `waitUntilReady`, which asks the provider whether
 * a deployment finished. That is a different question with a different answer:
 * a URL 404s for a moment after READY while its domain is assigned, and a
 * protected deployment answers 401 to you while being perfectly healthy for
 * the people it is meant for.
 *
 * So this is opt-in, and the caller decides what counts as serving. Most want
 * the default. A caller behind deployment protection wants to accept a 401, or
 * not to ask at all.
 */

import { Duration, Effect, Schedule, Schema } from "effect"

export class NotServingError extends Schema.TaggedError<NotServingError>()("NotServingError", {
  url: Schema.String,
  /** The last status seen, or absent if the request never got an answer. */
  status: Schema.optional(Schema.Number),
  waitedMs: Schema.Number
}) {}

export interface ServingOptions {
  /**
   * Whether a response means the deployment is serving. The default accepts
   * any 2xx and keeps waiting through 404 and 5xx, which is the propagation
   * window rather than a failure.
   */
  readonly accept?: (status: number) => boolean
  /** How often to ask, and for how long. Must be bounded. */
  readonly schedule?: Schedule.Schedule<unknown>
  /** Defaults to the global fetch, so a caller can supply their own. */
  readonly fetch?: typeof globalThis.fetch
}

const isSuccess = (status: number) => status >= 200 && status < 300

/** A minute of half-second checks: the window observed on Vercel is under 1s. */
const defaultSchedule = Schedule.spaced("500 millis").pipe(
  Schedule.upTo({ duration: Duration.minutes(1) })
)

/**
 * Poll a URL until it serves, or give up.
 *
 * Redirects are not followed. A deployment behind protection answers 302 to a
 * login page, and following it turns "I cannot see this" into a cheerful 200
 * from somewhere else entirely.
 */
export const waitUntilServing = (
  url: string,
  options: ServingOptions = {}
): Effect.Effect<number, NotServingError> =>
  Effect.gen(function* () {
    const accept = options.accept ?? isSuccess
    const doFetch = options.fetch ?? globalThis.fetch
    const started = Date.now()

    const probe = Effect.promise(() =>
      doFetch(url, { redirect: "manual" }).then(
        response => response.status,
        () => undefined
      )
    )

    const status = yield* probe.pipe(
      Effect.repeat({
        until: seen => seen !== undefined && accept(seen),
        schedule: options.schedule ?? defaultSchedule
      })
    )

    if (status === undefined || !accept(status)) {
      return yield* new NotServingError({
        url,
        ...(status !== undefined ? { status } : {}),
        waitedMs: Date.now() - started
      })
    }

    return status
  })
