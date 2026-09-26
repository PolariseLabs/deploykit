import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Artifact, Deploykit, Provider } from "@deploykit/core"

const recorded: Array<Provider.DeployOptions | undefined> = []
const bare: Provider.Provider = {
  name: "Bare",
  createApp: () => Effect.die("unused"),
  getApp: () => Effect.die("unused"),
  deleteApp: () => Effect.die("unused"),
  getDeployment: () => Effect.die("unused"),
  deploy: (appId, _artifact, options) => {
    recorded.push(options)
    return Effect.succeed(
      new Provider.Deployment({
        id: Provider.deploymentId.make("d"),
        name: Provider.deploymentName.make("d"),
        appId: Provider.appId.make(appId),
        status: "deployed"
      })
    )
  }
}

const kit = Deploykit.layer().pipe(
  Layer.provide(Layer.succeed(Provider.DeploymentProvider, bare)),
  Layer.provide(NodeFileSystem.layer)
)

it.effect("every deploy through one layer shares one pair of budgets", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const artifact = yield* Artifact.make([])
    yield* deploykit.deploy("app", artifact, { target: "production" })
    yield* deploykit.deploy("app", artifact)
    const [first, second] = recorded
    assert.strictEqual(first?.target, "production")
    assert.isDefined(first?.transferBudget)
    assert.strictEqual(first?.transferBudget, second?.transferBudget)
    assert.strictEqual(first?.stagingBudget, second?.stagingBudget)
  }).pipe(Effect.provide(kit))
)

it.effect("operations a provider lacks fail with UnsupportedError", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const error = yield* Effect.flip(deploykit.activateDeployment("app", "d"))
    assert.instanceOf(error, Provider.UnsupportedError)
    assert.strictEqual(error.capability, "activation")
    assert.isFalse(deploykit.capabilities.deferredActivation)
  }).pipe(Effect.provide(kit))
)
