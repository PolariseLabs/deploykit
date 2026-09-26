import { Effect, Stream } from "effect"
import { SourceError } from "./provider/errors.js"

/** Open a fresh scoped stream on every run. References contain no credentials. */
export interface FileSource {
  readonly open: (reference: string) => Stream.Stream<Uint8Array, SourceError>
}

/** Convenience boundary for small, bounded promise readers. */
export const fromPromise = (
  read: (reference: string, signal: AbortSignal) => Promise<Uint8Array>
): FileSource => ({
  open: reference =>
    Stream.fromEffect(
      Effect.tryPromise({
        try: signal => read(reference, signal),
        catch: () => new SourceError({ reference, message: "Source read failed" })
      })
    )
})

export type StreamReader = (
  reference: string,
  signal: AbortSignal
) => Promise<ReadableStream<Uint8Array>>

/** Opens a fresh Web stream and aborts its reader when the Effect stream closes. */
export const fromReadableStream = (read: StreamReader): FileSource => ({
  open: reference =>
    Stream.unwrap(
      Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          controller => Effect.sync(() => controller.abort())
        )
        const failure = () => new SourceError({ reference, message: "Source read failed" })
        const body = yield* Effect.tryPromise({
          try: () => read(reference, controller.signal),
          catch: failure
        })
        return Stream.fromReadableStream({ evaluate: () => body, onError: failure })
      })
    )
})
