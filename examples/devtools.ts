import { Effect } from "effect"
import * as Devtools from "@deploykit/devtools"
import * as Telemetry from "@deploykit/core/telemetry"

const sample = Effect.gen(function* () {
  yield* Telemetry.emit({ kind: "input", provider: "demo", files: 12, bytes: 12 * 1048576 })
  yield* Telemetry.observe("demo", "prepare", Effect.sleep("600 millis"))
  yield* Effect.forEach(
    Array.from({ length: 12 }, (_, i) => i),
    i =>
      Telemetry.observe("demo", "upload", Effect.sleep("350 millis")).pipe(
        Effect.andThen(
          Telemetry.emit({
            kind: "progress",
            provider: "demo",
            stage: "uploading",
            done: i + 1,
            total: 12,
            bytes: (i + 1) * 1048576
          })
        )
      )
  )
  yield* Telemetry.observe("demo", "waitUntilReady", Effect.sleep("2 seconds"))
})

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const devtools = yield* Devtools.make({ port: Number(process.env.PORT ?? 0) })
      console.log(`Local devtools: ${devtools.url} (simulated data; no provider calls)`)
      yield* devtools.track(sample, { label: "Demo deployment" })
      console.log("Demo finished. Press Ctrl+C to close the dashboard.")
      return yield* Effect.never
    })
  )
)
