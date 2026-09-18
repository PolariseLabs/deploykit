import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import * as Provider from "@deploykit/core/provider"
import { layerWith, makeCloudflareControl } from "../src/index.ts"
import { stubClient } from "./stub.ts"

/**
 * The Cloudflare adapter driven only through the portable contract.
 *
 * The point is not to test Cloudflare again; it is to check that a second
 * provider fits the same shape the first one defined, without the caller
 * knowing which is underneath.
 */
describe("through the contract", () => {
  const live = (stub = stubClient()) =>
    layerWith(stub.client).pipe(Layer.provideMerge(NodeFileSystem.layer))

  it.effect("creates, resolves and deletes an app", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.DeploymentProvider

      const app = yield* provider.createApp("alpha")
      const found = yield* provider.getApp(app.id)
      yield* provider.deleteApp(app.id)

      assert.strictEqual(app.name, "alpha")
      assert.deepStrictEqual(found, app)
    }).pipe(Effect.provide(live()))
  )

  /**
   * The difference that forced a change to core. A Pages project has a uuid
   * AND a name, and every endpoint takes the name, so an App carrying the
   * uuid would be an App you cannot use.
   */
  it.effect("uses the project name as the app id, not the uuid", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.DeploymentProvider

      const app = yield* provider.createApp("alpha")

      assert.strictEqual(app.id, "alpha", "the name, even though a uuid exists")
      assert.notStrictEqual(app.id, "uuid-1")
    }).pipe(Effect.provide(live()))
  )

  it.effect("reads a deployment back, which needs the app as well", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.DeploymentProvider

      const deployment = yield* provider.getDeployment("alpha", "dep_1")

      assert.strictEqual(deployment.status, "deployed")
      assert.strictEqual(deployment.appId, "alpha")
      assert.strictEqual(deployment.url, "https://abc.alpha.pages.dev")
    }).pipe(Effect.provide(live()))
  )

  it.effect("adopts an existing project by name", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.DeploymentProvider

      const found = yield* provider.findAppByName!("alpha")

      assert.isTrue(Option.isSome(found))
    }).pipe(Effect.provide(live()))
  )

  it.effect("reports a missing project as None rather than failing", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.DeploymentProvider

      const found = yield* provider.findAppByName!("nope")

      assert.isTrue(Option.isNone(found))
    }).pipe(Effect.provide(live(stubClient({ failWithStatus: 404 }))))
  )
})

describe("capabilities differ from Vercel's", () => {
  /**
   * The capability system earning its keep. Cloudflare protects previews with
   * Access policies, which is not Vercel's per-project password or SSO
   * toggle, so the adapter declares it does not do this rather than
   * pretending and failing somewhere deeper.
   */
  it("declares no access control at all", () => {
    const capabilities = Provider.capabilitiesOf(makeCloudflareControl(stubClient().client))

    assert.strictEqual(capabilities.accessModes.size, 0)
    assert.isUndefined(makeCloudflareControl(stubClient().client).setAccess)
  })

  it("does declare adoption by name, which it can do", () => {
    const capabilities = Provider.capabilitiesOf(makeCloudflareControl(stubClient().client))

    assert.isTrue(capabilities.adoptByName)
  })
})
