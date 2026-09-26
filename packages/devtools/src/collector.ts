import { Cause, Effect, Exit, Option, Queue } from "effect"
import * as Telemetry from "@deploykit/core/telemetry"

export interface RecordedEvent {
  readonly version: 1
  readonly runId: string
  readonly correlationId: string
  readonly sequence: number
  readonly timestamp: string
  readonly elapsedMs: number
  readonly event:
    | Telemetry.Event
    | { readonly kind: "run.started" }
    | {
        readonly kind: "run.finished"
        readonly outcome: "success" | "failure" | "interrupted"
        readonly failure?: Telemetry.Failure
      }
}
export interface OperationStats {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
  readonly failures: number
}
export interface Stats {
  readonly operations: Readonly<Record<string, OperationStats>>
  readonly cachedContents: number
  readonly inputFiles: number
  readonly inputBytes: number
  readonly uploadedFiles: number
  readonly uploadedBytes: number
  readonly uploadTotal: number
  readonly retries: number
  readonly retryDelayMs: number
  readonly finishedOperations: number
  readonly failedOperations: number
}
const initialStats: Stats = {
  operations: {},
  cachedContents: 0,
  inputFiles: 0,
  inputBytes: 0,
  uploadedFiles: 0,
  uploadedBytes: 0,
  uploadTotal: 0,
  retries: 0,
  retryDelayMs: 0,
  finishedOperations: 0,
  failedOperations: 0
}
const summarize = (stats: Stats, event: RecordedEvent["event"]): Stats => {
  switch (event.kind) {
    case "cache":
      return { ...stats, cachedContents: event.totalContents - event.missingContents }
    case "input":
      return { ...stats, inputFiles: event.files, inputBytes: event.bytes }
    case "retry.scheduled":
      return {
        ...stats,
        retries: stats.retries + 1,
        retryDelayMs: stats.retryDelayMs + event.delayMs
      }
    case "progress":
      return event.stage === "uploading"
        ? {
            ...stats,
            uploadedFiles: event.done ?? 0,
            uploadedBytes: event.bytes ?? 0,
            uploadTotal: event.total ?? 0
          }
        : stats
    case "operation.finished": {
      const name = `${event.provider}/${event.operation}`.slice(0, 256)
      const key =
        Object.hasOwn(stats.operations, name) || Object.keys(stats.operations).length < 64
          ? name
          : "other"
      const previous = stats.operations[key] ?? { count: 0, totalMs: 0, maxMs: 0, failures: 0 }
      return {
        ...stats,
        operations: {
          ...stats.operations,
          [key]: {
            count: previous.count + 1,
            totalMs: previous.totalMs + event.durationMs,
            maxMs: Math.max(previous.maxMs, event.durationMs),
            failures: previous.failures + (event.outcome === "failure" ? 1 : 0)
          }
        },
        finishedOperations: stats.finishedOperations + 1,
        failedOperations: stats.failedOperations + (event.outcome === "failure" ? 1 : 0)
      }
    }
    case "deployment":
    case "run.started":
    case "run.finished":
    case "operation.started":
      return stats
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
export interface Run {
  readonly id: string
  readonly correlationId: string
  readonly label: string
  readonly startedAt: number
  readonly durationMs: number
  readonly status: "running" | "success" | "failure" | "interrupted" | "unknown"
  readonly events: ReadonlyArray<RecordedEvent>
  readonly omittedEvents: number
  readonly stats: Stats
}
export interface Options {
  readonly onEvent?: (event: RecordedEvent) => Effect.Effect<void, unknown>
}

/** The bounded exporter runs separately so slow telemetry cannot hold up publishing. */
export const makeCollector = (options: Options = {}) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<RecordedEvent>(1024)
    let runs: ReadonlyArray<Run> = []
    let dropped = 0
    let exportFailures = 0
    let pending = 0
    let omittedRuns = 0
    if (options.onEvent !== undefined)
      yield* Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(queue)
          const result = yield* Effect.exit(
            Effect.suspend(() => options.onEvent!(event)).pipe(Effect.timeout("2 seconds"))
          )
          yield* Effect.sync(() => {
            pending--
            if (Exit.isFailure(result)) exportFailures++
          })
        })
      ).pipe(Effect.forkScoped)
    const snapshot = Effect.sync(() => ({
      timestamp: Date.now(),
      processRssBytes: process.memoryUsage().rss,
      dropped,
      exportFailures,
      pending,
      omittedRuns,
      runs: runs.map(run => ({
        ...run,
        durationMs: run.status === "running" ? Date.now() - run.startedAt : run.durationMs
      }))
    }))
    const track = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      settings: { readonly label: string; readonly correlationId?: string }
    ) =>
      Effect.suspend(() => {
        const id = crypto.randomUUID()
        const correlationId = settings.correlationId ?? id
        const started = performance.now()
        let sequence = 0
        const record = (event: RecordedEvent["event"]) =>
          Effect.sync(() => {
            const value: RecordedEvent = {
              version: 1,
              runId: id,
              correlationId,
              sequence: sequence++,
              timestamp: new Date().toISOString(),
              elapsedMs: performance.now() - started,
              event
            }
            runs = runs.map(run =>
              run.id !== id
                ? run
                : {
                    ...run,
                    stats: summarize(run.stats, event),
                    events: [...run.events.slice(-499), value],
                    omittedEvents: run.omittedEvents + (run.events.length >= 500 ? 1 : 0),
                    ...(event.kind === "run.finished"
                      ? {
                          status: event.failure?.outcome === "unknown" ? "unknown" : event.outcome,
                          durationMs: value.elapsedMs
                        }
                      : {})
                  }
            )
            if (options.onEvent !== undefined) {
              if (Queue.offerUnsafe(queue, value)) pending++
              else dropped++
            }
          })
        return Effect.gen(function* () {
          const parent = yield* Telemetry.Observer
          yield* Effect.sync(() => {
            if (runs.length >= 20) omittedRuns++
            runs = [
              ...runs.slice(-19),
              {
                id,
                correlationId,
                label: settings.label.slice(0, 256),
                startedAt: Date.now(),
                durationMs: 0,
                status: "running",
                events: [],
                omittedEvents: 0,
                stats: initialStats
              }
            ]
          })
          yield* record({ kind: "run.started" })
          return yield* effect.pipe(
            Effect.provideService(Telemetry.Observer, event =>
              record(event).pipe(
                Effect.andThen(
                  parent === undefined
                    ? Effect.void
                    : Telemetry.emit(event).pipe(Effect.provideService(Telemetry.Observer, parent))
                )
              )
            ),
            Effect.onExit(exit =>
              record({
                kind: "run.finished",
                outcome: Exit.isSuccess(exit)
                  ? "success"
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "interrupted"
                    : "failure",
                ...(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? {
                      failure: Telemetry.failure(
                        Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                      )
                    }
                  : {})
              })
            )
          )
        })
      })
    const flush = Effect.gen(function* () {
      while (pending > 0) yield* Effect.sleep("10 millis")
    }).pipe(Effect.timeoutOption("3 seconds"), Effect.map(Option.isSome))
    return { track, snapshot, flush }
  })
