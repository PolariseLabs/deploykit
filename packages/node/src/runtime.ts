import { Cause, Effect, Exit, Schema } from "effect"

export class AbortError extends Schema.TaggedError<AbortError>()("AbortError", {
  message: Schema.String
}) {}
export class ClientClosedError extends Schema.TaggedError<ClientClosedError>()(
  "ClientClosedError",
  {
    message: Schema.String
  }
) {}
export interface RunOptions {
  readonly signal?: AbortSignal
}

const cancelled = () => new AbortError({ message: "Operation cancelled" })

/** Reject before starting a fiber, since it may run before observing an aborted signal. */
export const rejectIfAborted = (signal: AbortSignal | undefined) =>
  signal?.aborted === true ? Promise.reject(cancelled()) : undefined

/** Preserve expected errors instead of exposing Effect's FiberFailure wrapper. */
export const unwrap = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) throw cancelled()
  throw Cause.squash(exit.cause)
}

export const run = <A, E>(effect: Effect.Effect<A, E>, options: RunOptions = {}): Promise<A> =>
  rejectIfAborted(options.signal) ?? Effect.runPromiseExit(effect, options).then(unwrap)

export const callback = <A>(fn: (value: A) => void | Promise<void>, value: A) =>
  Effect.tryPromise(() => Promise.resolve(fn(value))).pipe(Effect.ignore)
