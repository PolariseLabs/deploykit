import { get } from "node:http"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as Devtools from "@deploykit/devtools"
import * as Telemetry from "@deploykit/core/telemetry"

it.effect("concurrent runs stay correlated and event retention preserves aggregate metrics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const devtools = yield* Devtools.makeCollector()
      yield* Effect.forEach(
        ["a", "b"],
        correlationId =>
          devtools.track(
            Effect.gen(function* () {
              yield* Telemetry.emit({ kind: "input", provider: "test", files: 42, bytes: 84 })
              yield* Effect.forEach(Array.from({ length: 510 }), () =>
                Telemetry.emit({ kind: "retry.scheduled", attempt: 1, delayMs: 2 })
              )
            }),
            { label: correlationId, correlationId }
          ),
        { concurrency: 2 }
      )
      const snapshot = yield* devtools.snapshot
      assert.equal(snapshot.runs.length, 2)
      for (const run of snapshot.runs) {
        assert.equal(run.status, "success")
        assert.equal(run.events.length, 500)
        assert.equal(run.stats.retries, 510)
        assert.equal(run.stats.inputFiles, 42)
        assert(
          run.events.every(
            event => event.correlationId === run.correlationId && event.runId === run.id
          )
        )
        assert(run.omittedEvents > 0)
      }
    })
  )
)
it.effect("interrupted work remains interrupted and records a terminal event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const devtools = yield* Devtools.makeCollector()
      const started = yield* Deferred.make<void>()
      const fiber = yield* devtools
        .track(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
          label: "cancel"
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      assert.equal((yield* devtools.snapshot).runs[0]?.status, "interrupted")
    })
  )
)
it.live("blocked exporters cannot block deployment and report dropped events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const devtools = yield* Devtools.makeCollector({ onEvent: () => Effect.never })
      yield* devtools.track(
        Effect.forEach(Array.from({ length: 1100 }), () =>
          Telemetry.emit({ kind: "retry.scheduled", attempt: 1, delayMs: 0 })
        ),
        { label: "burst" }
      )
      const snapshot = yield* devtools.snapshot
      assert.equal(snapshot.runs[0]?.status, "success")
      assert(snapshot.dropped > 0)
      assert(snapshot.pending <= 1025)
    })
  )
)
it.live("local server serves snapshots and rejects foreign origins and hostnames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const devtools = yield* Devtools.make()
      yield* devtools.track(Effect.succeed(42), { label: "example" })
      const response = yield* Effect.tryPromise(() => fetch(`${devtools.url}/events`))
      assert.equal(response.status, 200)
      assert.include(yield* Effect.tryPromise(() => response.text()), '"label":"example"')
      const denied = yield* Effect.tryPromise(() =>
        fetch(`${devtools.url}/events`, { headers: { origin: "https://untrusted.test" } })
      )
      assert.equal(denied.status, 403)
      const rebound = yield* Effect.tryPromise(
        () =>
          new Promise<number>((resolve, reject) => {
            get(`${devtools.url}/events`, { headers: { host: "untrusted.test" } }, response => {
              response.resume()
              resolve(response.statusCode ?? 0)
            }).on("error", reject)
          })
      )
      assert.equal(rebound, 403)
      const page = yield* Effect.tryPromise(() => fetch(devtools.url))
      assert.include(page.headers.get("content-security-policy") ?? "", "frame-ancestors 'none'")
      assert.include(yield* Effect.tryPromise(() => page.text()), "Deploykit / local")
    })
  )
)
