import { assert, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as Telemetry from "@deploykit/core/telemetry"
import { makeUploadThrottle } from "../src/services/throttle.ts"
import { makeVercelClient } from "../src/services/http.ts"

it.effect("shared pacing separates request starts and emits wait timings", () =>
  Effect.gen(function* () {
    const throttle = makeUploadThrottle({ concurrency: 8, intervalMs: 100 })
    const times: Array<number> = []
    const events: Array<Telemetry.Event> = []
    const fiber = yield* Effect.forEach(
      [1, 2, 3],
      () =>
        throttle.run(
          Effect.gen(function* () {
            times.push(yield* Clock.currentTimeMillis)
          })
        ),
      { concurrency: "unbounded" }
    ).pipe(
      Effect.provideService(Telemetry.Observer, event =>
        Effect.sync(() => {
          events.push(event)
        })
      ),
      Effect.forkChild
    )
    yield* TestClock.adjust(200)
    yield* Fiber.join(fiber)
    assert.deepEqual(times, [0, 100, 200])
    assert.equal(
      events.filter(e => e.kind === "operation.finished" && e.operation === "uploadThrottle.wait")
        .length,
      2
    )
  })
)

it.effect("a cancelled upload releases its shared concurrency permit", () =>
  Effect.gen(function* () {
    const throttle = makeUploadThrottle({ concurrency: 1, intervalMs: 0 })
    const started = yield* Deferred.make<void>()
    const first = yield* throttle
      .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    let secondStarted = false
    const second = yield* throttle
      .run(
        Effect.sync(() => {
          secondStarted = true
        })
      )
      .pipe(Effect.forkChild)
    yield* TestClock.adjust(1)
    assert.isFalse(secondStarted)
    yield* Fiber.interrupt(first)
    yield* Fiber.join(second)
    assert.isTrue(secondStarted)
  })
)

it.effect("an extended server cooldown is rechecked by already waiting requests", () =>
  Effect.gen(function* () {
    const throttle = makeUploadThrottle("balanced")
    yield* throttle.cooldown(100)
    let startedAt = -1
    const fiber = yield* throttle
      .run(
        Effect.gen(function* () {
          startedAt = yield* Clock.currentTimeMillis
        })
      )
      .pipe(Effect.forkChild)
    yield* TestClock.adjust(50)
    yield* throttle.cooldown(200)
    yield* TestClock.adjust(100)
    assert.equal(startedAt, -1)
    yield* TestClock.adjust(100)
    yield* Fiber.join(fiber)
    assert.equal(startedAt, 250)
  })
)

it.effect("429 pauses other uploads and retries through the same client", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const calls: Array<number> = []
    const client = makeVercelClient({
      token: "test",
      uploadThrottle: { concurrency: 1, intervalMs: 0 },
      retry: { attempts: 2, baseDelay: 0 },
      fetch: () => {
        calls.push(clock.currentTimeMillisUnsafe())
        return Promise.resolve(
          calls.length === 1
            ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } })
            : Response.json({})
        )
      }
    })
    const fiber = yield* Effect.all(
      [client.uploadFile("a", new Uint8Array()), client.uploadFile("b", new Uint8Array())],
      { concurrency: 2 }
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(999)
    assert.deepEqual(calls, [0])
    yield* TestClock.adjust(1)
    yield* Fiber.join(fiber)
    assert.deepEqual(calls, [0, 1000, 1000])
  })
)

it.effect("rate-limit reset supplies a cooldown when Retry-After is absent", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const calls: Array<number> = []
    const client = makeVercelClient({
      token: "test",
      uploadThrottle: "fast",
      retry: { attempts: 2, baseDelay: 0 },
      fetch: () => {
        calls.push(clock.currentTimeMillisUnsafe())
        return Promise.resolve(
          calls.length === 1
            ? new Response("{}", { status: 429, headers: { "x-ratelimit-reset": "2" } })
            : Response.json({})
        )
      }
    })
    const fiber = yield* client.uploadFile("a", new Uint8Array()).pipe(Effect.forkChild)
    yield* TestClock.adjust(2000)
    yield* Fiber.join(fiber)
    assert.deepEqual(calls, [0, 2000])
  })
)

it.effect("invalid limits fail before transport without retrying", () =>
  Effect.gen(function* () {
    for (const limits of [
      { concurrency: 0, intervalMs: 0 },
      { concurrency: 33, intervalMs: 0 },
      { concurrency: 2, intervalMs: -1 },
      { concurrency: 2, intervalMs: NaN }
    ]) {
      let calls = 0
      const client = makeVercelClient({
        token: "test",
        uploadThrottle: limits,
        fetch: () => {
          calls++
          return Promise.resolve(Response.json({}))
        }
      })
      const error = yield* Effect.flip(client.uploadFile("a", new Uint8Array()))
      assert.equal(error.code, "invalid_upload_throttle")
      assert.equal(calls, 0)
    }
  })
)

it.effect("upload cooldown does not delay or retry deployment creation", () =>
  Effect.gen(function* () {
    let calls = 0
    const client = makeVercelClient({
      token: "test",
      uploadThrottle: "conservative",
      retry: { attempts: 1 },
      fetch: () => {
        calls++
        return Promise.resolve(
          new Response("{}", { status: 429, headers: { "Retry-After": "60" } })
        )
      }
    })
    yield* Effect.flip(client.uploadFile("a", new Uint8Array()))
    yield* Effect.flip(
      client.createDeployment({
        name: "test",
        projectId: "isolated",
        target: "production",
        files: []
      })
    )
    assert.equal(calls, 2)
  })
)

for (const operation of ["getProject", "uploadFile"] as const) {
  it.effect(`${operation} respects reset headers without a throttle preset`, () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const calls: Array<number> = []
      const client = makeVercelClient({
        token: "test",
        retry: { attempts: 2, baseDelay: 0 },
        fetch: async () => {
          calls.push(clock.currentTimeMillisUnsafe())
          return calls.length === 1
            ? new Response("{}", { status: 429, headers: { "x-ratelimit-reset": "2" } })
            : Response.json({ id: "app", name: "test" })
        }
      })
      const request =
        operation === "getProject"
          ? client.getProject("app").pipe(Effect.asVoid)
          : client.uploadFile("sha", new Uint8Array())
      const fiber = yield* request.pipe(Effect.forkChild)
      yield* TestClock.adjust(1999)
      assert.deepEqual(calls, [0])
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      assert.deepEqual(calls, [0, 2000])
    })
  )
}

it.effect("creation exposes the reset delay without retrying", () =>
  Effect.gen(function* () {
    let calls = 0
    const client = makeVercelClient({
      token: "test",
      fetch: async () => {
        calls++
        return Response.json(
          { error: { code: "rate_limited" } },
          {
            status: 429,
            headers: { "x-ratelimit-reset": "120" }
          }
        )
      }
    })
    const error = yield* Effect.flip(
      client.createDeployment({
        name: "test",
        projectId: "app",
        target: "production",
        files: []
      })
    )
    assert.equal(error.retryAfterMs, 120000)
    assert.equal(error.code, "rate_limited")
    assert.equal(calls, 1)
  })
)

it.effect("Retry-After takes precedence over reset and cancellation stops waiting", () =>
  Effect.gen(function* () {
    let calls = 0
    const client = makeVercelClient({
      token: "test",
      retry: { attempts: 2, baseDelay: 0 },
      fetch: async () => {
        calls++
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "3", "x-ratelimit-reset": "1" }
        })
      }
    })
    const fiber = yield* client.getProject("app").pipe(Effect.forkChild)
    yield* TestClock.adjust(2000)
    assert.equal(calls, 1)
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust(5000)
    assert.equal(calls, 1)
  })
)
