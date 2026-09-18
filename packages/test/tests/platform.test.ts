import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Schedule } from "effect"
import { Artifact, Entry, Platform } from "@deploykit/core"
import * as TestProvider from "../src/testProvider.ts"
import * as MemoryAppStore from "../src/memoryAppStore.ts"

/**
 * Platform wired up exactly as a consumer would wire it: the real
 * Platform.layer on top of the in-memory provider and store.
 *
 * provideMerge rather than provide so the two inspection handles stay
 * reachable. A plain `provide` would satisfy Platform's requirements and then
 * hide them, leaving the test unable to ask what the provider actually did.
 */
const live = (
  providerConfig: TestProvider.TestProviderConfig = {},
  storeConfig: MemoryAppStore.MemoryAppStoreConfig = {}
) =>
  Platform.layer.pipe(
    Layer.provideMerge(TestProvider.layer(providerConfig)),
    Layer.provideMerge(MemoryAppStore.layer(storeConfig))
  )

describe("getOrCreate", () => {
  it.effect("creates an app on first sight of a tenant, and records the mapping", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider
      const memory = yield* MemoryAppStore.MemoryAppStore

      const app = yield* platform.apps.getOrCreate({
        externalId: "customer-123",
        name: "customer-123"
      })

      assert.strictEqual(app.id, "app-1")
      assert.strictEqual((yield* test.snapshot).apps.size, 1)
      assert.strictEqual((yield* memory.snapshot).get("customer-123"), "app-1")
    }).pipe(Effect.provide(live()))
  )

  it.effect("returns the same app the second time, without creating another", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      const first = yield* platform.apps.getOrCreate({
        externalId: "customer-123",
        name: "customer-123"
      })
      const second = yield* platform.apps.getOrCreate({
        externalId: "customer-123",
        name: "customer-123"
      })

      assert.deepStrictEqual(second, first)
      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        1,
        "the second call must resolve, not create"
      )
    }).pipe(Effect.provide(live()))
  )

  it.effect("gives each tenant its own app", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      const a = yield* platform.apps.getOrCreate({ externalId: "a", name: "a" })
      const b = yield* platform.apps.getOrCreate({ externalId: "b", name: "b" })

      assert.notStrictEqual(a.id, b.id)
      assert.strictEqual((yield* test.snapshot).apps.size, 2)
    }).pipe(Effect.provide(live()))
  )

  it.effect("surfaces a store read failure as AppStoreError, not ProviderError", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      const error = yield* Effect.flip(
        platform.apps.getOrCreate({ externalId: "customer-123", name: "customer-123" })
      )

      assert.strictEqual(error._tag, "AppStoreError")
      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        0,
        "nothing should be created if we cannot even read the mapping"
      )
    }).pipe(Effect.provide(live({}, { failOn: { get: ["customer-123"] } })))
  )
})

describe("compensation", () => {
  it.effect("deletes the app it just created when recording the mapping fails", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider
      const memory = yield* MemoryAppStore.MemoryAppStore

      const error = yield* Effect.flip(
        platform.apps.getOrCreate({ externalId: "customer-123", name: "customer-123" })
      )

      assert.strictEqual(error._tag, "AppStoreError")
      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        0,
        "the orphan must be cleaned up, not left behind"
      )
      assert.strictEqual((yield* memory.snapshot).size, 0)
    }).pipe(Effect.provide(live({}, { failOn: { put: ["customer-123"] } })))
  )

  it.effect("leaves the app alone when everything succeeds", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      yield* platform.apps.getOrCreate({ externalId: "customer-123", name: "customer-123" })

      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        1,
        "compensation must not run on the happy path"
      )
    }).pipe(Effect.provide(live()))
  )

  /**
   * The worst case: the store write fails and the cleanup fails too. Effect
   * keeps both failures in the Cause, original first, so the operator can see
   * what went wrong and that an orphan was left behind.
   */
  it.effect("keeps both failures when the compensating delete also fails", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      const exit = yield* Effect.exit(
        platform.apps.getOrCreate({ externalId: "customer-123", name: "customer-123" })
      )

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const tags = exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error._tag)

        assert.deepStrictEqual(tags, ["AppStoreError", "ProviderError"])
      }

      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        1,
        "the orphan really is left behind, which is exactly why both errors matter"
      )
    }).pipe(
      Effect.provide(
        live({ failOn: { deleteApp: ["app-1"] } }, { failOn: { put: ["customer-123"] } })
      )
    )
  )
})

/** Zero delay, so polling tests finish in microseconds rather than seconds. */
const instant = Schedule.spaced(0).pipe(Schedule.upTo({ times: 20 }))

describe("deploy", () => {
  it.effect("starts a deployment for an app and hands back the pending record", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const artifact = yield* Artifact.make([yield* Entry.text("index.html", "hi")])

      const deployment = yield* platform.deploy(app, { artifact })

      assert.strictEqual(deployment.appId, app.id)
      assert.strictEqual(deployment.status, "pending")
    }).pipe(Effect.provide(live()))
  )

  it.effect("reads a deployment back by id", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const fetched = yield* platform.deployments.get(started.id)

      assert.strictEqual(fetched.id, started.id)
    }).pipe(Effect.provide(live()))
  )
})

describe("waitUntilReady", () => {
  it.effect("polls until the build is deployed", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const settled = yield* platform.deployments.waitUntilReady(started.id, instant)

      assert.strictEqual(settled.status, "deployed")
      assert.strictEqual(settled.url, `https://${started.name}.test.deploykit.dev`)
    }).pipe(Effect.provide(live()))
  )

  it.effect("stops on a failed build rather than polling forever", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const settled = yield* platform.deployments.waitUntilReady(started.id, instant)

      assert.strictEqual(settled.status, "failed", "failed is terminal too")
    }).pipe(Effect.provide(live({ failOn: { build: ["app-1"] } })))
  )

  /**
   * The reason waitUntilReady must be bounded. Without the cap this test would
   * hang the suite rather than fail it.
   */
  it.effect("gives up on a build that never finishes, reporting the last status", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const error = yield* Effect.flip(platform.deployments.waitUntilReady(started.id, instant))

      // The error channel is a union, so reading lastStatus needs the tag check
      // to narrow it: ProviderError has no such field.
      assert.strictEqual(error._tag, "DeploymentTimeoutError")
      if (error._tag === "DeploymentTimeoutError") {
        assert.strictEqual(error.deploymentId, started.id)
        assert.strictEqual(error.lastStatus, "pending", "a timeout is not a failure")
      }
    }).pipe(Effect.provide(live({ neverFinish: ["app-1"] })))
  )

  it.effect("returns straight away when the deployment is already terminal", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })
      yield* platform.deployments.waitUntilReady(started.id, instant)

      const again = yield* platform.deployments.waitUntilReady(started.id, instant)

      assert.strictEqual(again.status, "deployed")
    }).pipe(Effect.provide(live()))
  )
})
