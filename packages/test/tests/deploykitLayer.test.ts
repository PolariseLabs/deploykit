import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Schedule } from "effect"
import { Artifact, Deploykit, Entry } from "@deploykit/core"
import * as TestProvider from "../src/testProvider.ts"

it.live("deploykitLayer gives code under test a Deploykit and the inspection handle", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const app = yield* deploykit.createApp("site")
    const artifact = yield* Artifact.make([yield* Entry.text("index.html", "hi")])
    const live = yield* deploykit.deployAndWait(app.id, artifact, {
      wait: { schedule: Schedule.spaced("1 millis").pipe(Schedule.upTo({ duration: "1 second" })) }
    })
    const recorded = yield* (yield* TestProvider.TestProvider).artifactFor(live.id)
    assert.deepStrictEqual(
      Artifact.list(recorded).map(entry => entry.path),
      ["index.html"]
    )
  }).pipe(Effect.provide(TestProvider.deploykitLayer().pipe(Layer.provide(NodeFileSystem.layer))))
)
