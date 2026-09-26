import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { fetchText } from "@deploykit/core/http"

it.effect("interruption cancels response consumption and releases the reader", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          Deferred.doneUnsafe(started, Effect.void)
        },
        cancel: () => {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const task = yield* fetchText(async () => new Response(stream), "https://example.test").pipe(
      Effect.forkChild
    )
    yield* Deferred.await(started)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(task)
    assert.isTrue(cancelled)
  })
)
it.effect("oversized provider responses fail in the typed channel", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      fetchText(
        async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
        "https://example.test"
      )
    )
    assert.strictEqual(error._tag, "TransportError")
  })
)
