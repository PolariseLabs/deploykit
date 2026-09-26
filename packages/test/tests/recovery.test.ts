import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Artifact } from "@deploykit/core"
import * as TestProvider from "../src/testProvider.ts"

it.effect("a lost response is recoverable without creating another deployment", () =>
  Effect.gen(function* () {
    const test = yield* TestProvider.make({ lostCreateResponse: ["app-1"] })
    const provider = test.provider
    const app = yield* provider.createApp("app")
    const error = yield* Effect.flip(
      provider.deploy(app.id, Artifact.empty, { operationId: "op", activation: "deferred" })
    )
    if (error._tag !== "ProviderError") throw error
    assert.strictEqual(error.outcome, "unknown")
    const recovered = yield* provider.reconcileDeployment!(app.id, "op")
    if (recovered._tag !== "Recovered") throw new Error("Expected recovery")
    assert.strictEqual((yield* test.snapshot).deployments.size, 1)
    assert.strictEqual(
      (yield* provider.getActivation!(app.id, recovered.deployment.id)).state,
      "unknown"
    )
    yield* provider.getDeployment(app.id, recovered.deployment.id)
    yield* provider.getDeployment(app.id, recovered.deployment.id)
    yield* provider.activateDeployment!(app.id, recovered.deployment.id)
    assert.strictEqual(
      (yield* provider.getActivation!(app.id, recovered.deployment.id)).state,
      "active"
    )
  })
)
