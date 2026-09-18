import { Context, Effect, Exit, Layer, Option, Ref, Schedule, Schema } from "effect"
import {
  appId,
  DeploymentProvider,
  isTerminal,
  UnsupportedError,
  type Access,
  type DeployOptions as ProviderDeployOptions,
  type App,
  type DeploymentStatus,
  type Deployment
} from "../provider/provider.ts"
import { capabilitiesOf, type AccessMode, type Capabilities } from "../provider/capabilities.ts"
import type { ProviderError } from "../provider/errors.ts"
import type { AppStoreError, DeploymentTimeoutError } from "./errors.ts"
import { DeploymentTimeoutError as TimeoutError } from "./errors.ts"
import { TenantAppStore } from "./appStore.ts"
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

export interface WaitOptions {
  /** How often to ask, and for how long. Must be bounded. */
  readonly schedule?: Schedule.Schedule<unknown>
  /**
   * How many consecutive failed polls to ride out before giving up.
   *
   * A failed status check is not a failed deployment. The build is almost
   * certainly still running while the provider rate-limits us or drops a
   * request, and abandoning the wait turns their bad minute into our failure.
   * Defaults to 3, the same tolerance the consumer settled on.
   *
   * Distinct from transport retry, which makes a single call survive a blip
   * over seconds. This rides out a call that failed even after those retries.
   */
  readonly tolerateFailures?: number
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

    /**
     * Remove a tenant's app.
     *
     * The mapping goes too, or the next getOrCreate resolves an id the
     * provider no longer has. Offboarding is the ordinary reason a SaaS
     * deletes an app, so it belongs here rather than only on the adapter.
     */
    readonly delete: (
      options: DeleteAppOptions
    ) => Effect.Effect<void, ProviderError | AppStoreError>

    /**
     * Restrict who may open this app's deployments.
     *
     * Absent when the provider has no access model; `capabilities.accessModes`
     * says which modes it accepts.
     */
    readonly setAccess?: (
      id: string,
      access: Access
    ) => Effect.Effect<void, ProviderError | UnsupportedError>
  }

  readonly deploy: (app: App, options: DeployOptions) => Effect.Effect<Deployment, ProviderError>

  readonly deployments: {
    readonly get: (appId: string, deploymentId: string) => Effect.Effect<Deployment, ProviderError>

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
      appId: string,
      deploymentId: string,
      options?: WaitOptions
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
    const capabilities = capabilitiesOf(provider)

    return {
      capabilities,

      apps: {
        get: (id: string) => provider.getApp(id),

        /**
         * Provider first, then the store. If the provider fails the mapping
         * stays, which is recoverable: the next call resolves the app again.
         * Forgetting first would strand an app nothing points at.
         */
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

                /**
                 * Refuse a mode the provider does not declare, rather than
                 * letting it fail somewhere in the adapter as a generic
                 * error. The caller can act on this one.
                 */
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

      deploy: (app: App, options: DeployOptions) => {
        const { artifact, ...rest } = options
        return provider.deploy(app.id, artifact, rest)
      },

      deployments: {
        get: (appId: string, deploymentId: string) => provider.getDeployment(appId, deploymentId),

        waitUntilReady: (appId: string, id: string, options: WaitOptions = {}) =>
          Effect.gen(function* () {
            const schedule = options.schedule ?? defaultSchedule
            const tolerate = options.tolerateFailures ?? 3

            /** Consecutive failures, reset by any answer at all. */
            const misses = yield* Ref.make(0)
            /** The last status actually observed, for a timeout worth reading. */
            const seen = yield* Ref.make<DeploymentStatus | undefined>(undefined)

            const tick = provider.getDeployment(appId, id).pipe(
              Effect.tap(deployment =>
                Ref.set(misses, 0).pipe(Effect.andThen(Ref.set(seen, deployment.status)))
              ),
              Effect.map(deployment => ({ _tag: "Answered" as const, deployment })),
              Effect.catchTag("ProviderError", error =>
                Ref.updateAndGet(misses, n => n + 1).pipe(
                  Effect.map(consecutive => ({ _tag: "Missed" as const, error, consecutive }))
                )
              )
            )

            /**
             * repeat runs once, then repeats until the predicate holds or the
             * schedule runs out. Stopping on a terminal status is the happy
             * path; stopping on too many consecutive misses is giving up; the
             * schedule running out is the timeout.
             */
            const last = yield* tick.pipe(
              Effect.repeat({
                until: outcome =>
                  outcome._tag === "Answered"
                    ? isTerminal(outcome.deployment.status)
                    : outcome.consecutive >= tolerate,
                schedule
              })
            )

            if (last._tag === "Missed") {
              // The provider's error, not a timeout: we stopped because it kept
              // failing, and that error is what the caller needs to see.
              return yield* last.error
            }
            if (isTerminal(last.deployment.status)) {
              return last.deployment
            }
            return yield* new TimeoutError({
              deploymentId: id,
              lastStatus: yield* Ref.get(seen).pipe(
                Effect.map(status => status ?? last.deployment.status)
              )
            })
          })
      }
    }
  })
)
