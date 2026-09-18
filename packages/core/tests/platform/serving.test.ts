import { assert, describe, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { waitUntilServing } from "../../src/platform/serving.ts"

/** Zero delay so the retry behaviour is testable without waiting. */
const instant = Schedule.spaced(0).pipe(Schedule.upTo({ times: 10 }))

const responding = (statuses: ReadonlyArray<number | "throw">) => {
  let call = 0
  const calls = () => call
  const inits: Array<RequestInit | undefined> = []
  const fetch = ((_url: unknown, init?: RequestInit) => {
    inits.push(init)
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 200
    call += 1
    return status === "throw"
      ? Promise.reject(new Error("ECONNREFUSED"))
      : Promise.resolve(new Response("", { status }))
  }) as typeof globalThis.fetch
  return { fetch, calls, inits }
}

describe("waitUntilServing", () => {
  it.effect("returns as soon as the URL answers", () =>
    Effect.gen(function* () {
      const { fetch, calls } = responding([200])

      const status = yield* waitUntilServing("https://x.test", { fetch, schedule: instant })

      assert.strictEqual(status, 200)
      assert.strictEqual(calls(), 1)
    })
  )

  /**
   * The observed case: Vercel reports READY and the URL 404s for a few hundred
   * milliseconds while its domain is assigned. A single fetch right after a
   * terminal status tests the race, not the deployment.
   */
  it.effect("waits through the 404 window after a deployment goes ready", () =>
    Effect.gen(function* () {
      const { fetch, calls } = responding([404, 404, 200])

      const status = yield* waitUntilServing("https://x.test", { fetch, schedule: instant })

      assert.strictEqual(status, 200)
      assert.strictEqual(calls(), 3)
    })
  )

  it.effect("waits through a 5xx too", () =>
    Effect.gen(function* () {
      const { fetch } = responding([503, 200])
      assert.strictEqual(
        yield* waitUntilServing("https://x.test", { fetch, schedule: instant }),
        200
      )
    })
  )

  it.effect("waits through a request that got no answer at all", () =>
    Effect.gen(function* () {
      const { fetch } = responding(["throw", 200])
      assert.strictEqual(
        yield* waitUntilServing("https://x.test", { fetch, schedule: instant }),
        200
      )
    })
  )

  it.effect("gives up with the last status and how long it waited", () =>
    Effect.gen(function* () {
      const { fetch } = responding([404])

      const error = yield* Effect.flip(
        waitUntilServing("https://x.test", { fetch, schedule: instant })
      )

      assert.strictEqual(error._tag, "NotServingError")
      assert.strictEqual(error.status, 404)
      assert.strictEqual(error.url, "https://x.test")
      assert.isAtLeast(error.waitedMs, 0)
    })
  )

  /**
   * Following a redirect is how a check reports success while actually reading
   * Vercel's login page. That happened, so it is pinned.
   */
  it.effect("does not follow a redirect, and does not accept one", () =>
    Effect.gen(function* () {
      const { fetch, calls, inits } = responding([302])

      const error = yield* Effect.flip(
        waitUntilServing("https://x.test", { fetch, schedule: instant })
      )

      assert.strictEqual(error.status, 302)
      assert.isAbove(calls(), 1, "a redirect is retried, not taken as an answer")
      assert.strictEqual(
        inits[0]?.redirect,
        "manual",
        "following one is how a check reports success while reading a login page"
      )
    })
  )

  it.effect("lets a caller accept what it knows is fine", () =>
    Effect.gen(function* () {
      const { fetch } = responding([401])

      // Behind deployment protection a 401 means the site is up and we simply
      // cannot see it, which is not a failure of the deploy.
      const status = yield* waitUntilServing("https://x.test", {
        fetch,
        schedule: instant,
        accept: seen => seen === 401 || (seen >= 200 && seen < 300)
      })

      assert.strictEqual(status, 401)
    })
  )
})
