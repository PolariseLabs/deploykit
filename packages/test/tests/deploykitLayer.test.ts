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

it.live("a bad release can be rolled back, and the live deployment cannot be deleted", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const app = yield* deploykit.createApp("site")
    const artifact = yield* Artifact.make([])
    const wait = {
      wait: { schedule: Schedule.spaced("1 millis").pipe(Schedule.upTo({ duration: "1 second" })) }
    }
    const good = yield* deploykit.deployAndWait(app.id, artifact, wait)
    const bad = yield* deploykit.deployAndWait(app.id, artifact, wait)

    const [newest, previous] = yield* deploykit.listDeployments(app.id, { target: "production" })
    assert.deepStrictEqual([newest?.id, previous?.id], [bad.id, good.id])

    yield* deploykit.rollback(app.id, good.id)
    assert.strictEqual((yield* deploykit.getActivation(app.id, good.id)).state, "active")
    const refused = yield* Effect.flip(deploykit.deleteDeployment(app.id, good.id))
    assert.strictEqual(refused._tag, "UnsupportedError")
    yield* deploykit.deleteDeployment(app.id, bad.id)
    assert.lengthOf(yield* deploykit.listDeployments(app.id), 1)
  }).pipe(Effect.provide(TestProvider.deploykitLayer().pipe(Layer.provide(NodeFileSystem.layer))))
)
