import { Context, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import {
  appId,
  DeploymentProvider,
  isTerminal,
  type App,
  type Deployment
} from "../provider/provider.ts"
import { capabilitiesOf, type Capabilities } from "../provider/capabilities.ts"
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
  /** What the wired-up provider can do, for a caller deciding what to offer. */
  readonly capabilities: Capabilities

  readonly apps: {
    readonly getOrCreate: (
      options: GetOrCreateOptions
    ) => Effect.Effect<App, ProviderError | AppStoreError>
  }

  readonly deploy: (app: App, options: DeployOptions) => Effect.Effect<Deployment, ProviderError>

  readonly deployments: {
    readonly get: (id: string) => Effect.Effect<Deployment, ProviderError>

    /**
     * Poll until the provider says the deployment has stopped moving.
     *
     * That is all it means. It does NOT mean the URL serves: the provider
     * assigns the domain after the deployment finishes, so `url` can 404 for a
     * moment afterwards. Checking that is deliberately left to the caller,
     * because a protected deployment answers 401 to us while being perfectly
     * healthy for its real audience, and because "did the build fail" and "is
     * the CDN slow" are better as two questions than one ambiguous answer.
     *
     * The schedule is a parameter so a test can pass a zero-delay one; it must
     * be bounded, or a stuck build leaks a fiber per tenant.
     */
    readonly waitUntilReady: (
      id: string,
      schedule?: Schedule.Schedule<unknown>
    ) => Effect.Effect<Deployment, ProviderError | DeploymentTimeoutError>
  }
}

/**
 * Losing the race to record a mapping. Deliberately not exported: it is an
 * internal control-flow signal, caught a few lines after it is raised, and it
 * never reaches a caller. The error channel is a control-flow mechanism, not
 * only a way to report failure.
 */
class AppAlreadyRecordedError extends Schema.TaggedError<AppAlreadyRecordedError>()(
  "AppAlreadyRecordedError",
  {
    externalId: Schema.String,
    appId: appId
  }
) {}

/** A minute of one-second polls: slow enough to be polite, bounded so it ends. */
const defaultSchedule = Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "5 minutes" }))

export class Platform extends Context.Service<Platform, PlatformApi>()("@deploykit/Platform") {}

export const layer = Layer.effect(
  Platform,
  Effect.gen(function* () {
    const provider = yield* DeploymentProvider
    const store = yield* TenantAppStore

    return {
      capabilities: capabilitiesOf(provider),

      apps: {
        getOrCreate: (options: GetOrCreateOptions) =>
          Effect.gen(function* () {
            const storedId = yield* store.get(options.externalId)
            if (Option.isSome(storedId)) {
              return yield* provider.getApp(storedId.value)
            }

            /**
             * Nothing recorded, but an app may still exist: a previous create
             * whose mapping never landed, and whose compensating delete also
             * failed. Adopt it rather than create a duplicate.
             *
             * Only possible where the provider can resolve by name, so this is
             * a capability, not an assumption. Note there is no compensating
             * delete on this path: we did not create the app, so it is not ours
             * to remove if recording the mapping fails.
             */
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
              /**
               * Losing the race is reported as a failure so the release above
               * deletes the app we redundantly created, reusing the cleanup path
               * rather than writing a second one. Then we adopt the winner.
               */
              Effect.catchTag("AppAlreadyRecordedError", error => provider.getApp(error.appId))
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
