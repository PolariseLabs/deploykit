/**
 * An in-memory Provider for tests: no network, no timers, no randomness.
 *
 * Ids count up (`app-1`, `deployment-1`) and a build advances exactly one step
 * per getDeployment call, so the same test run twice sees the same thing twice.
 * Failures are opt-in through TestProviderConfig rather than simulated at
 * random, so an error path is something a test asks for, not something it waits
 * for.
 */

import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Artifact } from "@deploykit/core"
import { Provider } from "@deploykit/core"

/** Which calls fail, so error paths are testable without breaking anything real. */
export interface TestProviderConfig {
  readonly failOn?: {
    /** App names whose createApp fails, as a provider would on a name clash. */
    readonly createApp?: ReadonlyArray<string>
    /** App ids whose getApp fails. */
    readonly getApp?: ReadonlyArray<string>
    /** App ids whose deleteApp fails. */
    readonly deleteApp?: ReadonlyArray<string>
    /** App ids whose deploy fails before any deployment is recorded. */
    readonly deploy?: ReadonlyArray<string>
    /** App ids whose deploy is accepted but whose build ends in "failed". */
    readonly build?: ReadonlyArray<string>
  }
  /**
   * App ids whose deployments never leave "pending". Not a failure: it is a
   * build that hangs, which is what a poller's bound exists to survive.
   */
  readonly neverFinish?: ReadonlyArray<string>
  /**
   * Omit findAppByName, so the provider declares it cannot adopt by name. Models
   * a provider that addresses apps only by opaque id.
   */
  readonly withoutAdoptByName?: boolean
  /** Omit setAccess, modelling a provider with no access model at all. */
  readonly withoutAccessControl?: boolean
  /**
   * Fail the first N calls to getDeployment, then behave normally. Models a
   * provider that drops or throttles status checks while the build carries on
   * regardless, which is the case a poller has to ride out.
   */
  readonly failFirstPolls?: number
  /**
   * Fail getDeployment on these 1-based call numbers. Unlike failFirstPolls
   * this can interleave failures with answers, which is what distinguishes
   * "too many consecutive failures" from "too many failures".
   */
  readonly failPollsAt?: ReadonlyArray<number>
}

/** What the provider kept about one deployment, including the files it was handed. */
export interface DeploymentRecord {
  readonly deployment: Provider.Deployment
  readonly artifact: Artifact.Artifact
  readonly buildFails: boolean
  readonly stuck: boolean
}

/** Everything the provider has seen. Read it with `snapshot` to assert on it. */
export interface TestState {
  readonly apps: ReadonlyMap<string, Provider.App>
  readonly deployments: ReadonlyMap<string, DeploymentRecord>
  readonly nextAppId: number
  readonly nextDeploymentId: number
}

/** The in-memory provider plus the inspection handles tests need. */
export interface TestProviderApi {
  /** The contract implementation, to hand to code under test. */
  readonly provider: Provider.Provider
  /** Everything recorded so far. */
  readonly snapshot: Effect.Effect<TestState>
  /** What access was last set for an app, for assertions. */
  readonly accessFor: (id: string) => Effect.Effect<Option.Option<Provider.Access>>
  /** The exact artifact a deployment was created from. */
  readonly artifactFor: (
    deploymentId: string
  ) => Effect.Effect<Artifact.Artifact, Provider.ProviderError>
}

const initialState: TestState = {
  apps: new Map(),
  deployments: new Map(),
  nextAppId: 1,
  nextDeploymentId: 1
}

const failure = (
  message: string,
  fields: {
    readonly appId?: string
    readonly appName?: string
    readonly deploymentId?: string
  } = {}
) => new Provider.ProviderError({ provider: "test", message, ...fields })

/**
 * One step of the build. Terminal states stay put, so polling a finished
 * deployment is safe and idempotent.
 */
const nextStatus = (
  status: Provider.DeploymentStatus,
  buildFails: boolean,
  stuck: boolean
): Provider.DeploymentStatus => {
  if (stuck) {
    return status
  }

  switch (status) {
    case "pending":
      return "deploying"
    case "deploying":
      return buildFails ? "failed" : "deployed"
    case "deployed":
      return "deployed"
    case "failed":
      return "failed"
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

/** A URL appears only once the build succeeded, as it does with a real provider. */
const withStatus = (deployment: Provider.Deployment, status: Provider.DeploymentStatus) =>
  Provider.Deployment.make({
    id: deployment.id,
    name: deployment.name,
    appId: deployment.appId,
    status,
    url:
      status === "deployed"
        ? Provider.deploymentUrl.make(`https://${deployment.name}.test.deploykit.dev`)
        : undefined
  })

export const make = (config: TestProviderConfig = {}): Effect.Effect<TestProviderApi> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState)

    const failCreateApp = new Set(config.failOn?.createApp ?? [])
    const failGetApp = new Set(config.failOn?.getApp ?? [])
    const failDeleteApp = new Set(config.failOn?.deleteApp ?? [])
    const failDeploy = new Set(config.failOn?.deploy ?? [])
    const failBuild = new Set(config.failOn?.build ?? [])
    const neverFinish = new Set(config.neverFinish ?? [])
    const accessById = yield* Ref.make(new Map<string, Provider.Access>())
    const pollsToFail = yield* Ref.make(config.failFirstPolls ?? 0)
    const pollCount = yield* Ref.make(0)
    const failAt = new Set(config.failPollsAt ?? [])

    const createApp = (name: string) =>
      Effect.gen(function* () {
        if (failCreateApp.has(name)) {
          return yield* failure(`createApp is configured to fail for "${name}"`, { appName: name })
        }

        // Ref.modify reads and writes in one step, returning whatever the
        // first element of the tuple is. The second is the new state.
        return yield* Ref.modify(state, current => {
          const id = `app-${current.nextAppId}`
          const app = Provider.App.make({
            id: Provider.appId.make(id),
            name: Provider.appName.make(name)
          })
          return [
            app,
            {
              ...current,
              apps: new Map(current.apps).set(id, app),
              nextAppId: current.nextAppId + 1
            }
          ]
        })
      })

    const getApp = (id: string) =>
      Effect.gen(function* () {
        if (failGetApp.has(id)) {
          return yield* failure(`getApp is configured to fail for "${id}"`, { appId: id })
        }

        const { apps } = yield* Ref.get(state)
        const app = apps.get(id)

        return app === undefined ? yield* failure(`no app "${id}"`, { appId: id }) : app
      })

    const setAccess = (id: string, access: Provider.Access) =>
      Effect.gen(function* () {
        const { apps } = yield* Ref.get(state)
        if (!apps.has(id)) {
          return yield* failure(`no app "${id}"`, { appId: id })
        }
        yield* Ref.update(accessById, current => new Map(current).set(id, access))
      })

    const findAppByName = (name: string) =>
      Effect.gen(function* () {
        const { apps } = yield* Ref.get(state)
        return Option.fromUndefinedOr(Array.from(apps.values()).find(app => app.name === name))
      })

    const deleteApp = (id: string) =>
      Effect.gen(function* () {
        if (failDeleteApp.has(id)) {
          return yield* failure(`deleteApp is configured to fail for "${id}"`, { appId: id })
        }

        const { apps } = yield* Ref.get(state)
        if (!apps.has(id)) {
          return yield* failure(`no app "${id}"`, { appId: id })
        }

        yield* Ref.update(state, current => {
          const remaining = new Map(current.apps)
          remaining.delete(id)
          return { ...current, apps: remaining }
        })
      })

    const deploy = (appId: string, artifact: Artifact.Artifact) =>
      Effect.gen(function* () {
        if (failDeploy.has(appId)) {
          return yield* failure(`deploy is configured to fail for "${appId}"`, { appId })
        }

        const current = yield* Ref.get(state)
        if (!current.apps.has(appId)) {
          return yield* failure(`cannot deploy to unknown app "${appId}"`, { appId })
        }

        return yield* Ref.modify(state, current => {
          const id = `deployment-${current.nextDeploymentId}`
          const deployment = Provider.Deployment.make({
            id: Provider.deploymentId.make(id),
            name: Provider.deploymentName.make(id),
            appId: Provider.appId.make(appId),
            status: "pending",
            url: undefined
          })
          const record: DeploymentRecord = {
            deployment,
            artifact,
            buildFails: failBuild.has(appId),
            stuck: neverFinish.has(appId)
          }
          return [
            deployment,
            {
              ...current,
              deployments: new Map(current.deployments).set(id, record),
              nextDeploymentId: current.nextDeploymentId + 1
            }
          ]
        })
      })

    /**
     * Returns the status as it stands, then advances the stored one. A caller
     * that polls sees pending, then deploying, then deployed, which is the
     * shape real polling code has to cope with.
     */
    const getDeployment = (_appId: string, deploymentId: string) =>
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(pollCount, n => n + 1)
        const failing =
          failAt.has(call) ||
          (yield* Ref.modify(pollsToFail, remaining =>
            remaining > 0 ? [true, remaining - 1] : [false, remaining]
          ))
        if (failing) {
          return yield* failure(`getDeployment is configured to fail`, { deploymentId })
        }

        const { deployments } = yield* Ref.get(state)
        const record = deployments.get(deploymentId)

        if (record === undefined) {
          return yield* failure(`no deployment "${deploymentId}"`, { deploymentId })
        }

        yield* Ref.update(state, current => ({
          ...current,
          deployments: new Map(current.deployments).set(deploymentId, {
            ...record,
            deployment: withStatus(
              record.deployment,
              nextStatus(record.deployment.status, record.buildFails, record.stuck)
            )
          })
        }))

        return record.deployment
      })

    const artifactFor = (deploymentId: string) =>
      Effect.gen(function* () {
        const { deployments } = yield* Ref.get(state)
        const record = deployments.get(deploymentId)

        return record === undefined
          ? yield* failure(`no deployment "${deploymentId}"`, { deploymentId })
          : record.artifact
      })

    const base = {
      name: "test",
      createApp,
      getApp,
      deleteApp,
      deploy,
      getDeployment
    }

    return {
      // Spread rather than a property set to undefined: with
      // exactOptionalPropertyTypes, absent and undefined are different things,
      // and capabilitiesOf asks whether the key is absent.
      provider: {
        ...base,
        ...(config.withoutAdoptByName === true ? {} : { findAppByName }),
        ...(config.withoutAccessControl === true
          ? {}
          : {
              setAccess,
              accessModes: new Set<Provider.AccessMode>(["public", "sso"])
            })
      },
      accessFor: (id: string) =>
        Ref.get(accessById).pipe(Effect.map(all => Option.fromUndefinedOr(all.get(id)))),
      snapshot: Ref.get(state),
      artifactFor
    }
  })

/** The inspection handle, for tests that assert on what the provider recorded. */
export class TestProvider extends Context.Service<TestProvider, TestProviderApi>()(
  "@deploykit/TestProvider"
) {}

/**
 * Provides DeploymentProvider for the code under test and TestProvider for the
 * test's own assertions, both backed by the same instance.
 */
export const layer = (config: TestProviderConfig = {}) =>
  Layer.effect(
    Provider.DeploymentProvider,
    Effect.gen(function* () {
      const test = yield* TestProvider
      return test.provider
    })
  ).pipe(Layer.provideMerge(Layer.effect(TestProvider, make(config))))
