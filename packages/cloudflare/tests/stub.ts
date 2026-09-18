/**
 * A stand-in for Cloudflare's API. Plain object, no casting, because the
 * adapter depends on the eight calls it actually makes.
 */

import { Effect } from "effect"
import {
  CloudflareApiError,
  type AssetUpload,
  type CloudflareClient,
  type PagesDeployment,
  type PagesProject
} from "../src/services/client.ts"

export interface StubClient {
  readonly client: CloudflareClient
  readonly uploads: ReadonlyArray<AssetUpload>
  readonly manifests: ReadonlyArray<Readonly<Record<string, string>>>
  readonly checked: ReadonlyArray<ReadonlyArray<string>>
  readonly upserted: ReadonlyArray<ReadonlyArray<string>>
  readonly calls: ReadonlyArray<string>
}

export interface StubConfig {
  readonly project?: PagesProject
  readonly deployment?: PagesDeployment
  /** Hashes check-missing reports as absent. Defaults to all of them. */
  readonly missing?: ReadonlyArray<string>
  readonly failWithStatus?: number
  readonly failWithBody?: string
  /** upsert-hashes fails, which must not fail the deploy. */
  readonly failUpsert?: boolean
}

const defaultProject: PagesProject = { id: "uuid-1", name: "alpha" }
const defaultDeployment: PagesDeployment = {
  id: "dep_1",
  url: "https://abc.alpha.pages.dev",
  project_name: "alpha",
  latest_stage: { name: "deploy", status: "success" }
}

export const stubClient = (config: StubConfig = {}): StubClient => {
  const uploads: Array<AssetUpload> = []
  const manifests: Array<Readonly<Record<string, string>>> = []
  const checked: Array<ReadonlyArray<string>> = []
  const upserted: Array<ReadonlyArray<string>> = []
  const calls: Array<string> = []

  const project = config.project ?? defaultProject
  const deployment = config.deployment ?? defaultDeployment

  const fail = (operation: string) =>
    new CloudflareApiError({
      operation,
      message: `${operation} failed`,
      statusCode: config.failWithStatus ?? 500,
      ...(config.failWithBody !== undefined ? { body: config.failWithBody } : {})
    })

  const guard = <A>(operation: string, value: A): Effect.Effect<A, CloudflareApiError> => {
    calls.push(operation)
    return config.failWithStatus === undefined
      ? Effect.succeed(value)
      : Effect.fail(fail(operation))
  }

  return {
    uploads,
    manifests,
    checked,
    upserted,
    calls,
    client: {
      createProject: () => guard("createProject", project),
      getProject: () => guard("getProject", project),
      deleteProject: () => guard<void>("deleteProject", undefined),
      getDeployment: () => guard("getDeployment", deployment),
      uploadToken: () => guard("uploadToken", "jwt-token"),
      checkMissing: (_jwt, hashes) => {
        checked.push(hashes)
        return guard("checkMissing", config.missing ?? hashes)
      },
      uploadAssets: (_jwt, payload) => {
        uploads.push(...payload)
        return guard<void>("uploadAssets", undefined)
      },
      upsertHashes: (_jwt, hashes) => {
        upserted.push(hashes)
        calls.push("upsertHashes")
        return config.failUpsert === true ? Effect.fail(fail("upsertHashes")) : Effect.void
      },
      createDeployment: (_name, manifest) => {
        manifests.push(manifest)
        return guard("createDeployment", deployment)
      }
    }
  }
}
