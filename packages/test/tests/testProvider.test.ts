import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Artifact, Entry, Provider } from "@deploykit/core"
import * as TestProvider from "../src/testProvider.ts"

const artifactOf = (...entries: ReadonlyArray<Entry.Entry>) => Artifact.make(entries)

const indexHtml = Entry.text("index.html", "<h1>hello</h1>")

describe("createApp", () => {
  it.effect("assigns ids that count up, so a test can predict them", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const first = yield* provider.createApp("alpha")
      const second = yield* provider.createApp("beta")

      assert.strictEqual(first.id, "app-1")
      assert.strictEqual(second.id, "app-2")
      assert.strictEqual(first.name, "alpha")
    })
  )

  it.effect("fails for a name the config marks as taken", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make({ failOn: { createApp: ["taken"] } })

      const error = yield* Effect.flip(provider.createApp("taken"))

      assert.strictEqual(error._tag, "ProviderError")
      assert.strictEqual(error.appName, "taken")
      assert.strictEqual(error.provider, "test")
    })
  )

  it.effect("records the app so getApp can resolve it", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const created = yield* provider.createApp("alpha")
      const fetched = yield* provider.getApp(created.id)

      assert.deepStrictEqual(fetched, created)
    })
  )
})

describe("getApp", () => {
  it.effect("fails for an app that was never created", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const error = yield* Effect.flip(provider.getApp("app-99"))

      assert.strictEqual(error.appId, "app-99")
    })
  )
})

describe("deleteApp", () => {
  it.effect("removes the app, so it no longer resolves", () =>
    Effect.gen(function* () {
      const { provider, snapshot } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")

      yield* provider.deleteApp(app.id)

      assert.strictEqual((yield* snapshot).apps.size, 0)
      const error = yield* Effect.flip(provider.getApp(app.id))
      if (error._tag !== "ProviderError") throw error
      assert.strictEqual(error.appId, app.id)
    })
  )

  it.effect("leaves other tenants alone", () =>
    Effect.gen(function* () {
      const { provider, snapshot } = yield* TestProvider.make()
      const doomed = yield* provider.createApp("alpha")
      const keeper = yield* provider.createApp("beta")

      yield* provider.deleteApp(doomed.id)

      const state = yield* snapshot
      assert.strictEqual(state.apps.size, 1)
      assert.isTrue(state.apps.has(keeper.id))
    })
  )

  it.effect("fails for an app that was never created", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const error = yield* Effect.flip(provider.deleteApp("app-99"))

      assert.strictEqual(error.appId, "app-99")
    })
  )

  it.effect("fails when the config marks it as failing", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make({ failOn: { deleteApp: ["app-1"] } })
      const app = yield* provider.createApp("alpha")

      const error = yield* Effect.flip(provider.deleteApp(app.id))

      assert.match(error.message, /configured to fail/)
    })
  )
})

describe("deploy", () => {
  it.effect("starts a deployment in pending, with no URL yet", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")

      const deployment = yield* provider.deploy(app.id, yield* artifactOf(yield* indexHtml))

      assert.strictEqual(deployment.id, "deployment-1")
      assert.strictEqual(deployment.status, "pending")
      assert.strictEqual(deployment.url, undefined)
      assert.strictEqual(deployment.appId, app.id)
    })
  )

  it.effect("refuses an app that does not exist", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const error = yield* Effect.flip(provider.deploy("app-99", Artifact.empty))

      assert.match(error.message, /unknown app/)
    })
  )

  it.effect("fails when the config marks the app as failing", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make({ failOn: { deploy: ["app-1"] } })
      const app = yield* provider.createApp("alpha")

      const error = yield* Effect.flip(provider.deploy(app.id, Artifact.empty))

      if (error._tag !== "ProviderError") throw error
      assert.strictEqual(error.appId, app.id)
    })
  )

  it.effect("keeps the artifact it was given, so a test can assert on the files", () =>
    Effect.gen(function* () {
      const { provider, artifactFor } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")
      const artifact = yield* artifactOf(yield* indexHtml)

      const deployment = yield* provider.deploy(app.id, artifact)
      const deployed = yield* artifactFor(deployment.id)
      const entry = yield* Artifact.get(deployed, "index.html")

      assert.isTrue(Option.isSome(entry))
      assert.strictEqual(Option.getOrThrow(entry).path, "index.html")
      assert.strictEqual(Artifact.fileCount(deployed), 1)
    })
  )
})

describe("getDeployment", () => {
  it.effect("advances one step per call: pending, deploying, deployed", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")
      const deployment = yield* provider.deploy(app.id, yield* artifactOf(yield* indexHtml))

      const first = yield* provider.getDeployment(app.id, deployment.id)
      const second = yield* provider.getDeployment(app.id, deployment.id)
      const third = yield* provider.getDeployment(app.id, deployment.id)

      assert.strictEqual(first.status, "pending")
      assert.strictEqual(second.status, "deploying")
      assert.strictEqual(third.status, "deployed")
    })
  )

  it.effect("only publishes a URL once the build succeeded", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")
      const deployment = yield* provider.deploy(app.id, Artifact.empty)

      yield* provider.getDeployment(app.id, deployment.id)
      const deploying = yield* provider.getDeployment(app.id, deployment.id)
      const deployed = yield* provider.getDeployment(app.id, deployment.id)

      assert.strictEqual(deploying.url, undefined)
      assert.strictEqual(deployed.url, "https://deployment-1.test.deploykit.dev")
    })
  )

  it.effect("ends in failed when the config marks the build as failing", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make({ failOn: { build: ["app-1"] } })
      const app = yield* provider.createApp("alpha")
      const deployment = yield* provider.deploy(app.id, Artifact.empty)

      yield* provider.getDeployment(app.id, deployment.id)
      yield* provider.getDeployment(app.id, deployment.id)
      const settled = yield* provider.getDeployment(app.id, deployment.id)

      assert.strictEqual(settled.status, "failed")
      assert.strictEqual(settled.url, undefined)
    })
  )

  it.effect("stays put once terminal, so polling a finished build is safe", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")
      const deployment = yield* provider.deploy(app.id, Artifact.empty)

      yield* Effect.forEach([1, 2, 3], () => provider.getDeployment(app.id, deployment.id))
      const settled = yield* provider.getDeployment(app.id, deployment.id)
      const stillSettled = yield* provider.getDeployment(app.id, deployment.id)

      assert.strictEqual(settled.status, "deployed")
      assert.strictEqual(stillSettled.status, "deployed")
    })
  )

  it.effect("fails for a deployment that was never created", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const error = yield* Effect.flip(provider.getDeployment("app-1", "deployment-99"))

      assert.strictEqual(error.deploymentId, "deployment-99")
    })
  )
})

describe("snapshot", () => {
  it.effect("exposes everything recorded, for assertions the contract cannot make", () =>
    Effect.gen(function* () {
      const { provider, snapshot } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")
      yield* provider.deploy(app.id, Artifact.empty)
      yield* provider.deploy(app.id, Artifact.empty)

      const state = yield* snapshot

      assert.strictEqual(state.apps.size, 1)
      assert.strictEqual(state.deployments.size, 2)
    })
  )

  it.effect("starts empty, so instances do not leak between tests", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* TestProvider.make()

      const state = yield* snapshot

      assert.strictEqual(state.apps.size, 0)
      assert.strictEqual(state.deployments.size, 0)
    })
  )
})

it.layer(TestProvider.layer())("through the layer", it => {
  it.effect("satisfies DeploymentProvider for code that knows nothing about tests", () =>
    Effect.gen(function* () {
      const deployer = yield* Provider.DeploymentProvider

      const app = yield* deployer.createApp("alpha")
      const deployment = yield* deployer.deploy(app.id, yield* artifactOf(yield* indexHtml))

      assert.strictEqual(deployer.name, "test")
      assert.strictEqual(deployment.status, "pending")
    })
  )

  it.effect("backs both services with one instance, so assertions see the real calls", () =>
    Effect.gen(function* () {
      const deployer = yield* Provider.DeploymentProvider
      const test = yield* TestProvider.TestProvider

      const before = (yield* test.snapshot).apps.size
      const app = yield* deployer.createApp("beta")
      const after = yield* test.snapshot

      assert.strictEqual(after.apps.size, before + 1)
      assert.deepStrictEqual(after.apps.get(app.id), app)
    })
  )
})

describe("access control", () => {
  it.effect("records the access a caller sets", () =>
    Effect.gen(function* () {
      const { provider, accessFor } = yield* TestProvider.make()
      const app = yield* provider.createApp("alpha")

      yield* provider.setAccess!(app.id, { _tag: "Public" })

      const access = yield* accessFor(app.id)
      assert.deepStrictEqual(Option.getOrNull(access), { _tag: "Public" })
    })
  )

  it.effect("fails for an app that does not exist", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const error = yield* Effect.flip(provider.setAccess!("app-99", { _tag: "Public" }))

      assert.strictEqual(error.appId, "app-99")
    })
  )

  it.effect("declares which modes it accepts", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make()

      const capabilities = Provider.capabilitiesOf(provider)

      assert.isTrue(capabilities.accessModes.has("public"))
      assert.isTrue(capabilities.accessModes.has("sso"))
      assert.isFalse(
        capabilities.accessModes.has("password"),
        "the test provider does not do passwords, and says so"
      )
    })
  )

  it.effect("reports no modes at all when the provider has no access model", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestProvider.make({ withoutAccessControl: true })

      const capabilities = Provider.capabilitiesOf(provider)

      assert.strictEqual(capabilities.accessModes.size, 0)
      assert.strictEqual(provider.setAccess, undefined, "absent, not a stub that throws")
    })
  )
})
