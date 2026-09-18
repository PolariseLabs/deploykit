/**
 * An in-memory AppStore for tests.
 *
 * Real consumers back this with their own database; this one is a Map, so a
 * test can drive the tenant-to-app mapping without one. Failures are opt-in,
 * the same shape as TestProviderConfig, because the interesting paths in
 * Platform are the ones where the store misbehaves.
 */

import { Context, Effect, Layer, Option, Ref } from "effect"
import { Provider } from "@deploykit/core"
import { Platform } from "@deploykit/core"

export interface MemoryAppStoreConfig {
  readonly failOn?: {
    /** External ids whose get fails. */
    readonly get?: ReadonlyArray<string>
    /** External ids whose put fails, which is what triggers compensation. */
    readonly put?: ReadonlyArray<string>
    /**
     * External ids whose put fails only the FIRST time. Models a store that was
     * briefly down: the failure leaks an orphan, and the retry can then record
     * the adoption.
     */
    readonly putOnce?: ReadonlyArray<string>
  }
  /**
   * External ids that already have an app recorded, but whose FIRST get returns
   * None. That is precisely a lost race: our read happened before the other
   * caller's write, so our own write is the thing that discovers the conflict.
   * Deterministic, unlike actually racing two fibers.
   */
  readonly raceLostFor?: Readonly<Record<string, string>>
}

export interface MemoryAppStoreApi {
  readonly store: Platform.AppStore
  /** The mapping as it stands, for assertions. */
  readonly snapshot: Effect.Effect<ReadonlyMap<string, Provider.AppId>>
}

export const makeAppStore = (config: MemoryAppStoreConfig = {}): Effect.Effect<MemoryAppStoreApi> =>
  Effect.gen(function* () {
    const raced = Object.entries(config.raceLostFor ?? {})
    const state = yield* Ref.make(
      new Map<string, Provider.AppId>(
        raced.map(([externalId, winner]) => [externalId, Provider.appId.make(winner)])
      )
    )
    /** External ids still owed one None from get, to simulate the stale read. */
    const pendingRace = yield* Ref.make(new Set(raced.map(([externalId]) => externalId)))

    const failGet = new Set(config.failOn?.get ?? [])
    const failPut = new Set(config.failOn?.put ?? [])
    const failPutOnce = yield* Ref.make(new Set(config.failOn?.putOnce ?? []))

    const get = (externalId: string) =>
      Effect.gen(function* () {
        if (failGet.has(externalId)) {
          return yield* new Platform.AppStoreError({
            message: `get is configured to fail for "${externalId}"`,
            externalId
          })
        }

        const stale = yield* Ref.modify(pendingRace, owed => {
          if (!owed.has(externalId)) {
            return [false, owed]
          }
          const remaining = new Set(owed)
          remaining.delete(externalId)
          return [true, remaining]
        })
        if (stale) {
          return Option.none()
        }

        const mapping = yield* Ref.get(state)
        return Option.fromUndefinedOr(mapping.get(externalId))
      })

    const put = (externalId: string, appId: Provider.AppId) =>
      Effect.gen(function* () {
        const failingOnce = yield* Ref.modify(failPutOnce, owed => {
          if (!owed.has(externalId)) {
            return [false, owed]
          }
          const remaining = new Set(owed)
          remaining.delete(externalId)
          return [true, remaining]
        })

        if (failPut.has(externalId) || failingOnce) {
          return yield* new Platform.AppStoreError({
            message: `put is configured to fail for "${externalId}"`,
            externalId
          })
        }

        // Insert-if-absent in one step, which is what the contract demands of a
        // real store and what a unique constraint would give you.
        return yield* Ref.modify(state, mapping => {
          const existing = mapping.get(externalId)
          if (existing !== undefined) {
            return [{ _tag: "AlreadyRecorded", appId: existing } as Platform.PutOutcome, mapping]
          }
          return [
            { _tag: "Stored" } as Platform.PutOutcome,
            new Map(mapping).set(externalId, appId)
          ]
        })
      })

    return {
      store: { get, put },
      snapshot: Ref.get(state)
    }
  })

/** The inspection handle, for tests that assert on what was recorded. */
export class MemoryAppStore extends Context.Service<MemoryAppStore, MemoryAppStoreApi>()(
  "@deploykit/MemoryAppStore"
) {}

/** Provides TenantAppStore for code under test, and MemoryAppStore for assertions. */
export const layer = (config: MemoryAppStoreConfig = {}) =>
  Layer.effect(
    Platform.TenantAppStore,
    Effect.gen(function* () {
      const memory = yield* MemoryAppStore
      return memory.store
    })
  ).pipe(Layer.provideMerge(Layer.effect(MemoryAppStore, makeAppStore(config))))
