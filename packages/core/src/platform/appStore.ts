import type { Effect, Option } from "effect"
import { Context } from "effect"
import type { AppId } from "../provider/provider.ts"
import type { AppStoreError } from "./errors.ts"

/**
 * What a write found. A conflict is an outcome, not a failure: losing a race is
 * ordinary under concurrency, and the winner's id is the useful part.
 */
export type PutOutcome =
  { readonly _tag: "Stored" } | { readonly _tag: "AlreadyRecorded"; readonly appId: AppId }

export interface AppStore {
  /** The provider app id recorded for this tenant, if we have ever created one. */
  readonly get: (externalId: string) => Effect.Effect<Option.Option<AppId>, AppStoreError>

  /**
   * Record the mapping if, and only if, nothing is recorded yet.
   *
   * Must be atomic: back it with a unique constraint or a conditional write.
   * deploykit cannot make two systems atomic, but your database can already do
   * this for one key, so the contract asks for it rather than pretending.
   */
  readonly put: (externalId: string, appId: AppId) => Effect.Effect<PutOutcome, AppStoreError>

  /**
   * Drop a tenant's mapping, when its app has been deleted.
   *
   * Forgetting one that is not there is not an error: offboarding is often
   * retried, and the second attempt should be quiet.
   */
  readonly forget: (externalId: string) => Effect.Effect<void, AppStoreError>
}

export class TenantAppStore extends Context.Service<TenantAppStore, AppStore>()(
  "@deploykit/AppStore"
) {}
