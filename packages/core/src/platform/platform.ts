import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  appId,
  DeploymentProvider,
  UnsupportedError,
  type Access,
  type DeployOptions as ProviderDeployOptions,
  type App,
  type Deployment
} from "../provider/provider.ts"
import { capabilitiesOf, type AccessMode, type Capabilities } from "../provider/capabilities.ts"
import type { TransferError, ProviderError } from "../provider/errors.ts"
import type { AppStoreError, DeploymentTimeoutError } from "./errors.ts"
import { TenantAppStore } from "./appStore.ts"
import { waitUntilReady, type WaitOptions } from "./wait.ts"
import type { Artifact } from "../artifact/index.ts"

export interface GetOrCreateOptions {
  readonly externalId: string
  readonly name: string
}
export interface DeleteAppOptions {
  /** The tenant whose mapping should be forgotten along with the app. */
  readonly externalId: string
  readonly appId: string
}

export interface DeployOptions extends ProviderDeployOptions {
  readonly artifact: Artifact
}
export interface PlatformApi {
  /** What the wired-up provider can do, for a caller deciding what to offer. */
  readonly capabilities: Capabilities

  readonly apps: {
    readonly getOrCreate: (
      options: GetOrCreateOptions
    ) => Effect.Effect<App, ProviderError | AppStoreError>

    /** Resolve an app deploykit already knows about. */
    readonly get: (id: string) => Effect.Effect<App, ProviderError>

    readonly delete: (
      options: DeleteAppOptions
    ) => Effect.Effect<void, ProviderError | AppStoreError>

    readonly setAccess?: (
      id: string,
      access: Access
    ) => Effect.Effect<void, ProviderError | UnsupportedError>
  }

  readonly deploy: (
    app: App,
    options: DeployOptions
  ) => Effect.Effect<Deployment, ProviderError | TransferError | UnsupportedError>

  readonly deployments: {
    readonly get: (appId: string, deploymentId: string) => Effect.Effect<Deployment, ProviderError>

    readonly waitUntilReady: (
      appId: string,
      deploymentId: string,
      options?: WaitOptions
    ) => Effect.Effect<Deployment, ProviderError | DeploymentTimeoutError>
  }
}

class AppAlreadyRecordedError extends Schema.TaggedError<AppAlreadyRecordedError>()(
  "AppAlreadyRecordedError",
  {
    externalId: Schema.String,
    appId: appId
  }
) {}

/** A minute of one-second polls: slow enough to be polite, bounded so it ends. */
export class Platform extends Context.Service<Platform, PlatformApi>()("@deploykit/Platform") {}

export const layer = Layer.effect(
  Platform,
  Effect.gen(function* () {
    const provider = yield* DeploymentProvider
    const store = yield* TenantAppStore
    const capabilities = capabilitiesOf(provider)

    return {
      capabilities,

      apps: {
        get: (id: string) => provider.getApp(id),

        delete: (options: DeleteAppOptions) =>
          Effect.gen(function* () {
            yield* provider.deleteApp(options.appId)
            yield* store.forget(options.externalId)
          }),

        ...(provider.setAccess === undefined
          ? {}
          : {
              setAccess: (id: string, access: Access) => {
                const mode: AccessMode =
                  access._tag === "Public"
                    ? "public"
                    : access._tag === "Password"
                      ? "password"
                      : "sso"

                return capabilities.accessModes.has(mode)
                  ? provider.setAccess!(id, access)
                  : Effect.fail(
                      new UnsupportedError({
                        provider: provider.name,
                        capability: `access:${mode}`,
                        message: `${provider.name} supports ${[...capabilities.accessModes].join(", ") || "no access modes"}`
                      })
                    )
              }
            }),

        getOrCreate: (options: GetOrCreateOptions) =>
          Effect.gen(function* () {
            const storedId = yield* store.get(options.externalId)
            if (Option.isSome(storedId)) {
              return yield* provider.getApp(storedId.value)
            }

            if (provider.findAppByName !== undefined) {
              const existing = yield* provider.findAppByName(options.name)
              if (Option.isSome(existing)) {
                const adopted = existing.value
                return yield* store
                  .put(options.externalId, adopted.id)
                  .pipe(
                    Effect.flatMap(outcome =>
                      outcome._tag === "Stored"
                        ? Effect.succeed(adopted)
                        : provider.getApp(outcome.appId)
                    )
                  )
              }
            }

            return yield* Effect.acquireUseRelease(
              provider.createApp(options.name),
              app =>
                store.put(options.externalId, app.id).pipe(
                  Effect.flatMap(outcome =>
                    outcome._tag === "Stored"
                      ? Effect.succeed(app)
                      : new AppAlreadyRecordedError({
                          externalId: options.externalId,
                          appId: outcome.appId
                        })
                  )
                ),
              (app, exit) => (Exit.isFailure(exit) ? provider.deleteApp(app.id) : Effect.void)
            ).pipe(
              Effect.catchTag("AppAlreadyRecordedError", error => provider.getApp(error.appId))
            )
          })
      },

      deploy: (app: App, options: DeployOptions) => {
        const { artifact, ...rest } = options
        return provider.deploy(app.id, artifact, rest)
      },

      deployments: {
        get: (appId: string, deploymentId: string) => provider.getDeployment(appId, deploymentId),

        waitUntilReady: (appId: string, id: string, options?: WaitOptions) =>
          waitUntilReady(provider, appId, id, options)
      }
    }
  })
)
