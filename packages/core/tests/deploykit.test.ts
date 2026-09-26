import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Schedule } from "effect"
import { Artifact, Deploykit, Platform, Provider } from "@deploykit/core"

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

const polling = (statuses: ReadonlyArray<Provider.DeploymentStatus>) => {
  let polls = 0
  const deployment = (status: Provider.DeploymentStatus) =>
    new Provider.Deployment({
      id: Provider.deploymentId.make("d"),
      name: Provider.deploymentName.make("d"),
      appId: Provider.appId.make("app"),
      status,
      ...(status === "failed" ? { reason: "Build rejected" } : {})
    })
  const provider: Provider.Provider = {
    ...bare,
    deploy: () => Effect.succeed(deployment("pending")),
    getDeployment: () =>
      Effect.sync(() => deployment(statuses[Math.min(polls++, statuses.length - 1)]!))
  }
  return Deploykit.layer().pipe(
    Layer.provide(Layer.succeed(Provider.DeploymentProvider, provider)),
    Layer.provide(NodeFileSystem.layer)
  )
}
const fast = {
  wait: { schedule: Schedule.spaced("1 millis").pipe(Schedule.upTo({ duration: "1 second" })) }
}

it.live("deployAndWait polls until the deployment is live", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const live = yield* deploykit.deployAndWait("app", yield* Artifact.make([]), fast)
    assert.strictEqual(live.status, "deployed")
  }).pipe(Effect.provide(polling(["deploying", "deploying", "deployed"])))
)

it.live("deployAndWait turns a failed deployment into DeploymentFailedError", () =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const error = yield* Effect.flip(deploykit.deployAndWait("app", yield* Artifact.make([]), fast))
    assert.instanceOf(error, Platform.DeploymentFailedError)
    assert.strictEqual(error.reason, "Build rejected")
  }).pipe(Effect.provide(polling(["deploying", "failed"])))
)
