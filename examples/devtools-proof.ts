import assert from "node:assert/strict"
import { Effect } from "effect"
import * as Devtools from "@deploykit/devtools"
import * as Telemetry from "@deploykit/core/telemetry"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const delivered: Array<Devtools.RecordedEvent> = []
      const devtools = yield* Devtools.make({
        onEvent: event =>
          Effect.sync(() => {
            delivered.push(event)
          })
      })
      const result = yield* devtools.track(
        Telemetry.observe("consumer", "verify", Effect.succeed(42)),
        { label: "Packed consumer", correlationId: "publish-1" }
      )
      assert.equal(result, 42)
      assert.equal(yield* devtools.flush, true)
      assert.equal(delivered.length, 4)
      const response = yield* Effect.tryPromise(() => fetch(`${devtools.url}/events`))
      assert.equal(response.status, 200)
      assert.match(yield* Effect.tryPromise(() => response.text()), /publish-1/)
    })
  )
)
console.log(
  "Packed devtools proof passed: local HTTP, telemetry correlation, exporter, scoped shutdown"
)
