/**
 * An in-memory AppStore for tests.
 *
 * Real consumers back this with their own database; this one is a Map, so a
 * test can drive the tenant-to-app mapping without one. Failures are opt-in,
 * the same shape as TestProviderConfig, because the interesting paths in
 * Platform are the ones where the store misbehaves.
 */

import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Provider } from "@deploykit/core"
import { Platform } from "@deploykit/core"

export interface MemoryAppStoreConfig {
  readonly failOn?: {
    /** External ids whose get fails. */
    readonly get?: ReadonlyArray<string>
    /** External ids whose put fails, which is what triggers compensation. */
    readonly put?: ReadonlyArray<string>
  }
}

export interface MemoryAppStoreApi {
  readonly store: Platform.AppStore
  /** The mapping as it stands, for assertions. */
  readonly snapshot: Effect.Effect<ReadonlyMap<string, Provider.AppId>>
}

export const makeAppStore = (config: MemoryAppStoreConfig = {}): Effect.Effect<MemoryAppStoreApi> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, Provider.AppId>())

    const failGet = new Set(config.failOn?.get ?? [])
    const failPut = new Set(config.failOn?.put ?? [])

    const get = (externalId: string) =>
      Effect.gen(function* () {
        if (failGet.has(externalId)) {
          return yield* new Platform.AppStoreError({
            message: `get is configured to fail for "${externalId}"`,
            externalId
          })
        }

        const mapping = yield* Ref.get(state)
        return Option.fromUndefinedOr(mapping.get(externalId))
      })

    const put = (externalId: string, appId: Provider.AppId) =>
      Effect.gen(function* () {
        if (failPut.has(externalId)) {
          return yield* new Platform.AppStoreError({
            message: `put is configured to fail for "${externalId}"`,
            externalId
          })
        }

        yield* Ref.update(state, mapping => new Map(mapping).set(externalId, appId))
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
