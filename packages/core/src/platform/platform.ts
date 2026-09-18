import { Context, Effect, Exit, Layer, Option, Schedule } from "effect"
import { DeploymentProvider, isTerminal, type App, type Deployment } from "../provider/provider.ts"
import type { ProviderError } from "../provider/errors.ts"
import type { AppStoreError, DeploymentTimeoutError } from "./errors.ts"
import { DeploymentTimeoutError as TimeoutError } from "./errors.ts"
import { TenantAppStore } from "./appStore.ts"
import type { Artifact } from "../artifact/index.ts"

export interface GetOrCreateOptions {
  readonly externalId: string
  readonly name: string
}
export interface DeployOptions {
  readonly artifact: Artifact
}
export interface PlatformApi {
  readonly apps: {
    readonly getOrCreate: (
      options: GetOrCreateOptions
    ) => Effect.Effect<App, ProviderError | AppStoreError>
  }

  readonly deploy: (app: App, options: DeployOptions) => Effect.Effect<Deployment, ProviderError>

  readonly deployments: {
    readonly get: (id: string) => Effect.Effect<Deployment, ProviderError>

    /**
     * Poll until the deployment stops moving. The schedule is a parameter so a
     * test can pass a zero-delay one; it must be bounded, or a stuck build
     * leaks a fiber per tenant.
     */
    readonly waitUntilReady: (
      id: string,
      schedule?: Schedule.Schedule<unknown>
    ) => Effect.Effect<Deployment, ProviderError | DeploymentTimeoutError>
  }
}

/** A minute of one-second polls: slow enough to be polite, bounded so it ends. */
const defaultSchedule = Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "5 minutes" }))

export class Platform extends Context.Service<Platform, PlatformApi>()("@deploykit/Platform") {}

export const layer = Layer.effect(
  Platform,
  Effect.gen(function* () {
    const provider = yield* DeploymentProvider
    const store = yield* TenantAppStore

    return {
      apps: {
        getOrCreate: (options: GetOrCreateOptions) =>
          Effect.gen(function* () {
            const storedId = yield* store.get(options.externalId)
            if (Option.isSome(storedId)) {
              return yield* provider.getApp(storedId.value)
            }

            return yield* Effect.acquireUseRelease(
              provider.createApp(options.name),
              app => store.put(options.externalId, app.id).pipe(Effect.as(app)),
              (app, exit) => (Exit.isFailure(exit) ? provider.deleteApp(app.id) : Effect.void)
            )
          })
      },

      deploy: (app: App, options: DeployOptions) => provider.deploy(app.id, options.artifact),

      deployments: {
        get: (id: string) => provider.getDeployment(id),

        waitUntilReady: (id: string, schedule: Schedule.Schedule<unknown> = defaultSchedule) =>
          Effect.gen(function* () {
            const deployment = yield* provider
              .getDeployment(id)
              .pipe(Effect.repeat({ until: d => isTerminal(d.status), schedule }))

            return isTerminal(deployment.status)
              ? deployment
              : yield* new TimeoutError({ deploymentId: id, lastStatus: deployment.status })
          })
      }
    }
  })
)
