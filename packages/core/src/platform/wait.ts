import { Effect, Ref, Schedule } from "effect"
import { isTerminal, type ControlPlane, type DeploymentStatus } from "../provider/provider.ts"
import { DeploymentTimeoutError as TimeoutError } from "./errors.ts"

export interface WaitOptions {
  /** How often to ask, and for how long. Must be bounded. */
  readonly schedule?: Schedule.Schedule<unknown>

  readonly tolerateFailures?: number
}

const defaultSchedule = Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "5 minutes" }))

/**
 * Poll until the deployment reaches a terminal status. A `failed` deployment is
 * returned, not raised: it is an answer, and the caller decides what it means.
 */
export const waitUntilReady = (
  provider: Pick<ControlPlane, "getDeployment">,
  appId: string,
  id: string,
  options: WaitOptions = {}
) =>
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
      lastStatus: yield* Ref.get(seen).pipe(Effect.map(status => status ?? last.deployment.status))
    })
  })
