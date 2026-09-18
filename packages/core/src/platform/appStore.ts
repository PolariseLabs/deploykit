import type { Effect, Option } from "effect"
import { Context } from "effect"
import type { AppId } from "../provider/provider.ts"
import type { AppStoreError } from "./errors.ts"

export interface AppStore {
  readonly get: (externalId: string) => Effect.Effect<Option.Option<AppId>, AppStoreError>

  readonly put: (externalId: string, appId: AppId) => Effect.Effect<void, AppStoreError>
}

export class TenantAppStore extends Context.Service<TenantAppStore, AppStore>()(
  "@deploykit/AppStore"
) {}
