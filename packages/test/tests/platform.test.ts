import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Schedule } from "effect"
import { Artifact, Entry, Platform, Provider } from "@deploykit/core"
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

      const settled = yield* platform.deployments.waitUntilReady(started.id, { schedule: instant })

      assert.strictEqual(settled.status, "deployed")
      assert.strictEqual(settled.url, `https://${started.name}.test.deploykit.dev`)
    }).pipe(Effect.provide(live()))
  )

  it.effect("stops on a failed build rather than polling forever", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const settled = yield* platform.deployments.waitUntilReady(started.id, { schedule: instant })

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

      const error = yield* Effect.flip(
        platform.deployments.waitUntilReady(started.id, { schedule: instant })
      )

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
      yield* platform.deployments.waitUntilReady(started.id, { schedule: instant })

      const again = yield* platform.deployments.waitUntilReady(started.id, { schedule: instant })

      assert.strictEqual(again.status, "deployed")
    }).pipe(Effect.provide(live()))
  )
})

describe("concurrency", () => {
  /**
   * The race: two callers both read "no app yet", so both create one. The store
   * is the only component that can settle it, because a unique constraint on
   * externalId is exactly this problem already solved. The loser must end up
   * with the winner's app and must not leave its own behind.
   */
  it.effect("the loser adopts the winner's app instead of creating a second", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform

      // The winner gets app-1 and records it.
      const winner = yield* platform.apps.getOrCreate({ externalId: "winner", name: "winner" })

      // c1's read is stale, so it creates app-2, then discovers app-1 is recorded.
      const loser = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual(loser.id, winner.id, "the loser must adopt, not duplicate")
    }).pipe(Effect.provide(live({}, { raceLostFor: { c1: "app-1" } })))
  )

  it.effect("the loser deletes the app it redundantly created", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      yield* platform.apps.getOrCreate({ externalId: "winner", name: "winner" })
      yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      const state = yield* test.snapshot
      assert.strictEqual(state.apps.size, 1, "app-2 must have been cleaned up")
      assert.isTrue(state.apps.has("app-1"))
      assert.isFalse(state.apps.has("app-2"))
    }).pipe(Effect.provide(live({}, { raceLostFor: { c1: "app-1" } })))
  )

  it.effect("the mapping still points at the winner afterwards", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const memory = yield* MemoryAppStore.MemoryAppStore

      yield* platform.apps.getOrCreate({ externalId: "winner", name: "winner" })
      yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual((yield* memory.snapshot).get("c1"), "app-1")
    }).pipe(Effect.provide(live({}, { raceLostFor: { c1: "app-1" } })))
  )

  it.effect("a later call for the loser resolves normally, with no race left", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      yield* platform.apps.getOrCreate({ externalId: "winner", name: "winner" })
      yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const again = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual(again.id, "app-1")
      assert.strictEqual((yield* test.snapshot).apps.size, 1)
    }).pipe(Effect.provide(live({}, { raceLostFor: { c1: "app-1" } })))
  )
})

describe("AppStore contract", () => {
  it.effect("put stores when nothing is recorded", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryAppStore.makeAppStore()

      const outcome = yield* memory.store.put("c1", Provider.appId.make("app-1"))

      assert.strictEqual(outcome._tag, "Stored")
      assert.strictEqual((yield* memory.snapshot).get("c1"), "app-1")
    })
  )

  it.effect("put reports the incumbent rather than overwriting it", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryAppStore.makeAppStore()
      yield* memory.store.put("c1", Provider.appId.make("app-1"))

      const outcome = yield* memory.store.put("c1", Provider.appId.make("app-2"))

      assert.strictEqual(outcome._tag, "AlreadyRecorded")
      if (outcome._tag === "AlreadyRecorded") {
        assert.strictEqual(outcome.appId, "app-1")
      }
      assert.strictEqual(
        (yield* memory.snapshot).get("c1"),
        "app-1",
        "a second write must not clobber the first"
      )
    })
  )
})

describe("adopting an orphan", () => {
  /**
   * The exact hole compensation could not close: an app was created, recording
   * the mapping failed, AND the compensating delete failed too. An app now
   * exists that the store knows nothing about. Without adoption the next call
   * creates a second one, forever.
   */
  const orphaned = live({ failOn: { deleteApp: ["app-1"] } }, { failOn: { put: ["c1"] } })

  it.effect("leaves an orphan when compensation fails, as established", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      yield* Effect.exit(platform.apps.getOrCreate({ externalId: "c1", name: "c1" }))

      assert.strictEqual((yield* test.snapshot).apps.size, 1, "the orphan exists")
    }).pipe(Effect.provide(orphaned))
  )

  it.effect("adopts the orphan on the next call instead of creating a duplicate", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider
      const memory = yield* MemoryAppStore.MemoryAppStore

      // First call leaks an orphan named c1.
      yield* Effect.exit(platform.apps.getOrCreate({ externalId: "c1", name: "c1" }))
      // Second call: the store now accepts writes again.
      const adopted = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual(adopted.id, "app-1", "the orphan was adopted")
      assert.strictEqual((yield* test.snapshot).apps.size, 1, "no duplicate was created")
      assert.strictEqual((yield* memory.snapshot).get("c1"), "app-1", "and now recorded")
    }).pipe(
      Effect.provide(live({ failOn: { deleteApp: ["app-1"] } }, { failOn: { putOnce: ["c1"] } }))
    )
  )

  it.effect("does not adopt when no app of that name exists", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual(app.id, "app-1", "a fresh create, not an adoption")
      assert.strictEqual((yield* test.snapshot).apps.size, 1)
    }).pipe(Effect.provide(live()))
  )

  it.effect("does not adopt an app belonging to a different name", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform

      yield* platform.apps.getOrCreate({ externalId: "other", name: "other" })
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.notStrictEqual(app.id, "app-1", "names must not collide across tenants")
    }).pipe(Effect.provide(live()))
  )
})

describe("capabilities", () => {
  it.effect("reports adoptByName when the provider implements it", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      assert.isTrue(platform.capabilities.adoptByName)
    }).pipe(Effect.provide(live()))
  )

  it.effect("reports it false when the provider omits the operation", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      assert.isFalse(platform.capabilities.adoptByName)
    }).pipe(Effect.provide(live({ withoutAdoptByName: true })))
  )

  it.effect("a provider without the capability still creates, it just cannot adopt", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider

      yield* Effect.exit(platform.apps.getOrCreate({ externalId: "c1", name: "c1" }))
      yield* Effect.exit(platform.apps.getOrCreate({ externalId: "c1", name: "c1" }))

      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        2,
        "without adoption the duplicate is real, and capabilities says so"
      )
    }).pipe(
      Effect.provide(
        live(
          { withoutAdoptByName: true, failOn: { deleteApp: ["app-1", "app-2"] } },
          { failOn: { put: ["c1"] } }
        )
      )
    )
  )
})

describe("adoption, the cases equality of names would hide", () => {
  /**
   * Every other test uses externalId === name, so looking the app up by the
   * wrong one of the two is invisible. Here they differ: the app is named
   * "pretty", the tenant is "c1", and adoption must search by NAME.
   */
  it.effect("looks the orphan up by app name, not by tenant id", () =>
    Effect.gen(function* () {
      const test = yield* TestProvider.TestProvider
      const platform = yield* Platform.Platform

      // An orphan named "pretty", recorded nowhere.
      yield* test.provider.createApp("pretty")

      const adopted = yield* platform.apps.getOrCreate({ externalId: "c1", name: "pretty" })

      assert.strictEqual(adopted.id, "app-1", "found by name")
      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        1,
        "searching by tenant id would have found nothing and created a duplicate"
      )
    }).pipe(Effect.provide(live()))
  )

  /**
   * Adoption can lose the race too: we find an orphan, but between our read and
   * our write another caller recorded a different app. The winner's app is the
   * answer, and the orphan must be left alone because we never created it.
   */
  it.effect("yields to the winner when recording the adoption conflicts", () =>
    Effect.gen(function* () {
      const test = yield* TestProvider.TestProvider
      const platform = yield* Platform.Platform

      yield* test.provider.createApp("winner") // app-1, the recorded winner
      yield* test.provider.createApp("c1") // app-2, the orphan we will find

      const resolved = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.strictEqual(resolved.id, "app-1", "the winner wins, not the orphan we found")
      assert.strictEqual(
        (yield* test.snapshot).apps.size,
        2,
        "the orphan stays: we adopted it, we did not create it, so it is not ours to delete"
      )
    }).pipe(Effect.provide(live({}, { raceLostFor: { c1: "app-1" } })))
  )
})

describe("polling through failures", () => {
  /**
   * A failed status check is not a failed deployment. The build carries on
   * while the provider drops a request, and abandoning the wait turns their
   * bad minute into our failure. This is the behaviour deploykit lacked and
   * the consumer had.
   */
  it.effect("rides out a few failed polls and still reports the result", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const settled = yield* platform.deployments.waitUntilReady(started.id, {
        schedule: instant
      })

      assert.strictEqual(settled.status, "deployed")
    }).pipe(Effect.provide(live({ failFirstPolls: 2 })))
  )

  it.effect("gives up after too many consecutive failures, with the provider's error", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const error = yield* Effect.flip(
        platform.deployments.waitUntilReady(started.id, {
          schedule: instant,
          tolerateFailures: 2
        })
      )

      assert.strictEqual(
        error._tag,
        "ProviderError",
        "the provider's failure, not a timeout: we stopped because it kept failing"
      )
    }).pipe(Effect.provide(live({ failFirstPolls: 50 })))
  )

  it.effect("counts consecutive failures, not total: one good poll resets it", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      // Fails on polls 1 and 3, answering in between. Two failures total,
      // never two in a row. With a tolerance of 2 this only survives if an
      // answer resets the counter.
      const settled = yield* platform.deployments.waitUntilReady(started.id, {
        schedule: instant,
        tolerateFailures: 2
      })

      assert.strictEqual(settled.status, "deployed")
    }).pipe(Effect.provide(live({ failPollsAt: [1, 3] })))
  )

  it.effect("a timeout still reports the last status actually seen", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      const started = yield* platform.deploy(app, { artifact: Artifact.empty })

      const error = yield* Effect.flip(
        platform.deployments.waitUntilReady(started.id, { schedule: instant })
      )

      assert.strictEqual(error._tag, "DeploymentTimeoutError")
      if (error._tag === "DeploymentTimeoutError") {
        assert.strictEqual(error.lastStatus, "pending")
      }
    }).pipe(Effect.provide(live({ neverFinish: ["app-1"] })))
  )
})

describe("offboarding", () => {
  it.effect("removes the app and forgets the mapping", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider
      const memory = yield* MemoryAppStore.MemoryAppStore
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      yield* platform.apps.delete({ externalId: "c1", appId: app.id })

      assert.strictEqual((yield* test.snapshot).apps.size, 0, "the app is gone")
      assert.strictEqual((yield* memory.snapshot).size, 0, "and so is the mapping")
    }).pipe(Effect.provide(live()))
  )

  /**
   * Order matters. Forgetting first would strand an app nothing points at;
   * failing to delete while the mapping survives is recoverable, because the
   * next call resolves the same app and can try again.
   */
  it.effect("keeps the mapping when the provider refuses to delete", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const memory = yield* MemoryAppStore.MemoryAppStore
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      const error = yield* Effect.flip(platform.apps.delete({ externalId: "c1", appId: app.id }))

      assert.strictEqual(error._tag, "ProviderError")
      assert.strictEqual(
        (yield* memory.snapshot).get("c1"),
        app.id,
        "still pointing at it, so offboarding can be retried"
      )
    }).pipe(Effect.provide(live({ failOn: { deleteApp: ["app-1"] } })))
  )

  it.effect("a tenant deleted and recreated gets a fresh app", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const first = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })
      yield* platform.apps.delete({ externalId: "c1", appId: first.id })

      const second = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.notStrictEqual(second.id, first.id, "not the id of an app that is gone")
    }).pipe(Effect.provide(live()))
  )

  it.effect("exposes the provider's access control through Platform", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      const test = yield* TestProvider.TestProvider
      const app = yield* platform.apps.getOrCreate({ externalId: "c1", name: "c1" })

      assert.isDefined(platform.apps.setAccess)
      yield* platform.apps.setAccess!(app.id, { _tag: "Public" })

      const access = yield* test.accessFor(app.id)
      assert.deepStrictEqual(Option.getOrNull(access), { _tag: "Public" })
    }).pipe(Effect.provide(live()))
  )

  it.effect("omits setAccess when the provider has no access model", () =>
    Effect.gen(function* () {
      const platform = yield* Platform.Platform
      assert.strictEqual(platform.apps.setAccess, undefined)
    }).pipe(Effect.provide(live({ withoutAccessControl: true })))
  )
})
