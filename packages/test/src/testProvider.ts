import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Artifact } from "@deploykit/core"
import { Deploykit, Provider } from "@deploykit/core"

/** Which calls fail, so error paths are testable without breaking anything real. */
export interface TestProviderConfig {
  readonly lostCreateResponse?: ReadonlyArray<string>

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

  readonly neverFinish?: ReadonlyArray<string>

  readonly withoutAdoptByName?: boolean
  /** Omit setAccess, modelling a provider with no access model at all. */
  readonly withoutAccessControl?: boolean

  readonly failFirstPolls?: number

  readonly failPollsAt?: ReadonlyArray<number>
}

/** What the provider kept about one deployment, including the files it was handed. */
export interface DeploymentRecord {
  readonly operationId?: string

  readonly deployment: Provider.Deployment
  readonly target: "production" | "preview"
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
    const active = yield* Ref.make(new Map<string, string>())

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

    const deploy = (
      appId: string,
      artifact: Artifact.Artifact,
      options: Provider.DeployOptions = {}
    ) =>
      Effect.gen(function* () {
        if (failDeploy.has(appId)) {
          return yield* failure(`deploy is configured to fail for "${appId}"`, { appId })
        }

        const current = yield* Ref.get(state)
        if (!current.apps.has(appId)) {
          return yield* failure(`cannot deploy to unknown app "${appId}"`, { appId })
        }

        const created = yield* Ref.modify(state, current => {
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
            target: options.target ?? "production",
            artifact,
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
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
        if (options.activation !== "deferred" && options.target !== "preview")
          yield* Ref.update(active, values => new Map(values).set(appId, created.id))
        if (config.lostCreateResponse?.includes(appId))
          return yield* new Provider.ProviderError({
            provider: "test",
            operation: "createDeployment",
            message: "Response lost",
            appId,
            outcome: "unknown",
            recovery: "reconcile"
          })
        return created
      })

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
      deferredActivation: true,
      previewDeployments: true,
      reconcileDeployment: (
        appId: string,
        operationId: string
      ): Effect.Effect<Provider.Reconciliation> =>
        Ref.get(state).pipe(
          Effect.map(current => {
            const found = [...current.deployments.values()].filter(
              record => record.deployment.appId === appId && record.operationId === operationId
            )
            return found.length === 1
              ? { _tag: "Recovered", deployment: found[0]!.deployment }
              : {
                  _tag: "Unknown",
                  candidates: found.map(record => record.deployment.id),
                  reason: "No unique match"
                }
          })
        ),
      activateDeployment: (appId: string, deploymentId: string) =>
        Effect.gen(function* () {
          const record = (yield* Ref.get(state)).deployments.get(deploymentId)
          if (record?.deployment.appId !== appId || record.deployment.status !== "deployed")
            return yield* failure("Deployment is not ready for activation", { appId, deploymentId })
          yield* Ref.update(active, values => new Map(values).set(appId, deploymentId))
          return { appId, deploymentId, state: "active" as const }
        }),
      getActivation: (appId: string, deploymentId: string) =>
        Ref.get(active).pipe(
          Effect.map(values => ({
            appId,
            deploymentId,
            state: values.get(appId) === deploymentId ? ("active" as const) : ("unknown" as const)
          }))
        ),
      listDeployments: (appId: string, options?: Provider.ListDeploymentsOptions) =>
        Ref.get(state).pipe(
          Effect.map(current =>
            [...current.deployments.values()]
              .filter(
                record =>
                  record.deployment.appId === appId &&
                  (options?.target === undefined || record.target === options.target)
              )
              .reverse()
              .slice(0, Provider.listLimit(options))
              .map(record => record.deployment)
          )
        ),
      deleteDeployment: (appId: string, deploymentId: string) =>
        Effect.gen(function* () {
          const record = (yield* Ref.get(state)).deployments.get(deploymentId)
          if (record?.deployment.appId !== appId)
            return yield* failure(`no deployment "${deploymentId}"`, { appId, deploymentId })
          if ((yield* Ref.get(active)).get(appId) === deploymentId)
            return yield* new Provider.UnsupportedError({
              provider: "test",
              capability: "deleteDeployment",
              message: "The deployment serving production cannot be deleted"
            })
          yield* Ref.update(state, current => {
            const deployments = new Map(current.deployments)
            deployments.delete(deploymentId)
            return { ...current, deployments }
          })
        }),
      rollback: (appId: string, deploymentId: string) =>
        Effect.gen(function* () {
          const record = (yield* Ref.get(state)).deployments.get(deploymentId)
          if (
            record?.deployment.appId !== appId ||
            record.deployment.status !== "deployed" ||
            record.target !== "production"
          )
            return yield* failure("Rollback needs a ready production deployment", {
              appId,
              deploymentId
            })
          yield* Ref.update(active, values => new Map(values).set(appId, deploymentId))
          return { appId, deploymentId, state: "active" as const }
        }),
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

export const layer = (config: TestProviderConfig = {}) =>
  Layer.effect(
    Provider.DeploymentProvider,
    Effect.gen(function* () {
      const test = yield* TestProvider
      return test.provider
    })
  ).pipe(Layer.provideMerge(Layer.effect(TestProvider, make(config))))

/**
 * `Deploykit` over the in-memory provider, for testing code that deploys.
 * Also provides `TestProvider`, to assert on what was deployed. Needs a `FileSystem`.
 */
export const deploykitLayer = (config: TestProviderConfig & Deploykit.Limits = {}) =>
  Deploykit.layer(config).pipe(Layer.provideMerge(layer(config)))
