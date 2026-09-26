import { Cause, Context, Effect, Exit, Option } from "effect"

export interface Failure {
  readonly tag: string
  readonly operation?: string
  readonly statusCode?: number
  readonly code?: string
  readonly requestId?: string
  readonly outcome?: string
  readonly recovery?: string
}

export interface OperationDetails {
  readonly contentId?: string
  readonly bytes?: number
}
const CurrentOperation = Context.Reference<string | undefined>("@deploykit/TelemetryOperation", {
  defaultValue: () => undefined
})
export type Event =
  | {
      readonly kind: "deployment"
      readonly provider: string
      readonly id: string
      readonly status: string
      readonly url?: string
    }
  | {
      readonly kind: "cache"
      readonly provider: string
      readonly totalContents: number
      readonly missingContents: number
      readonly missingBytes: number
    }
  | {
      readonly kind: "progress"
      readonly provider: string
      readonly stage: "hashing" | "uploading" | "created"
      readonly done?: number
      readonly total?: number
      readonly bytes?: number
      readonly deploymentId?: string
    }
  | {
      readonly kind: "retry.scheduled"
      readonly attempt: number
      readonly delayMs: number
      readonly statusCode?: number
    }
  | {
      readonly kind: "input"
      readonly provider: string
      readonly files: number
      readonly bytes: number
    }
  | {
      readonly kind: "operation.started"
      readonly id: string
      readonly provider: string
      readonly operation: string
      readonly parentId?: string
      readonly details?: OperationDetails
    }
  | {
      readonly kind: "operation.finished"
      readonly id: string
      readonly provider: string
      readonly operation: string
      readonly parentId?: string
      readonly details?: OperationDetails
      readonly durationMs: number
      readonly outcome: "success" | "failure" | "interrupted"
      readonly failure?: Failure
    }

export const Observer = Context.Reference<((event: Event) => Effect.Effect<void>) | undefined>(
  "@deploykit/Telemetry",
  { defaultValue: () => undefined }
)

/** Export only diagnostic fields, never messages, bodies, file paths or source references. */
export const failure = (error: unknown): Failure => {
  if (typeof error !== "object" || error === null) return { tag: "Defect" }
  const text = (key: string) =>
    key in error && typeof Reflect.get(error, key) === "string"
      ? String(Reflect.get(error, key)).slice(0, 256)
      : undefined
  return {
    tag: text("_tag") ?? "Defect",
    ...(text("operation") === undefined ? {} : { operation: text("operation")! }),
    ...("statusCode" in error && typeof error.statusCode === "number"
      ? { statusCode: error.statusCode }
      : {}),
    ...Object.fromEntries(
      ["code", "requestId", "outcome", "recovery"].flatMap(key => {
        const value = text(key)
        return value === undefined ? [] : [[key, value]]
      })
    )
  }
}

/** Observer failures cannot change the observed operation's result. */
export const observe = <A, E, R>(
  provider: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
  details?: OperationDetails
) =>
  Effect.gen(function* () {
    const observer = yield* Observer
    if (observer === undefined) return yield* effect
    const parentId = yield* CurrentOperation
    const context = {
      ...(parentId === undefined ? {} : { parentId }),
      ...(details === undefined ? {} : { details })
    }
    const id = crypto.randomUUID()
    const started = performance.now()
    const emit = (event: Event) =>
      Effect.suspend(() => observer(event)).pipe(
        Effect.timeoutOption("10 millis"),
        Effect.asVoid,
        Effect.catchCause(() => Effect.void)
      )
    yield* emit({ kind: "operation.started", id, provider, operation, ...context })
    return yield* effect.pipe(
      Effect.provideService(CurrentOperation, id),
      Effect.onExit(exit => {
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        return emit({
          kind: "operation.finished",
          id,
          provider,
          operation,
          ...context,
          durationMs: performance.now() - started,
          outcome: Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupted"
              : "failure",
          ...(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? { failure: failure(Option.getOrUndefined(error)) }
            : {})
        })
      })
    )
  }).pipe(Effect.withSpan(`deploykit.${provider}.${operation}`))

/** Install an observer in the caller's Effect context to receive SDK events. */
export const emit = (event: Event) =>
  Effect.gen(function* () {
    const observer = yield* Observer
    if (observer !== undefined)
      yield* Effect.suspend(() => observer(event)).pipe(
        Effect.timeoutOption("10 millis"),
        Effect.asVoid,
        Effect.catchCause(() => Effect.void)
      )
  })
