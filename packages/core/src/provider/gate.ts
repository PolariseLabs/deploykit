import { Effect } from "effect"

/**
 * Coordinates request rate across every process that shares one provider token.
 *
 * Provider rate limits are per token, not per process, so a fleet of workers
 * can only stay under them together. Back this with a shared store (Redis,
 * a database, a Durable Object). Within one process the adapters already pace
 * themselves; a gate is only needed once several processes deploy at once.
 */
export interface RequestGate {
  /** Resolves when this request may be sent. */
  readonly acquire: (operation: string) => Effect.Effect<void>
  /** The provider rate-limited us; every process should hold off this long. */
  readonly backoff: (delayMs: number) => Effect.Effect<void>
}

export const openGate: RequestGate = { acquire: () => Effect.void, backoff: () => Effect.void }

/** A gate written with Promises, for callers not using Effect. */
export interface PromiseRequestGate {
  readonly acquire: (operation: string, signal: AbortSignal) => Promise<void>
  readonly backoff: (delayMs: number) => Promise<void>
}

/**
 * Adapts a Promise gate. It fails open: if the shared store is down, requests
 * still go out and the provider's own 429s remain the backstop.
 */
export const fromPromiseGate = (gate: PromiseRequestGate): RequestGate => ({
  acquire: operation =>
    Effect.tryPromise(signal => gate.acquire(operation, signal)).pipe(Effect.ignore),
  backoff: delayMs => Effect.tryPromise(() => gate.backoff(delayMs)).pipe(Effect.ignore)
})
