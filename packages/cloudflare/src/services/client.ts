/**
 * The slice of Cloudflare's API this adapter uses.
 *
 * Two authorities, not one. Project operations use the account API token;
 * asset operations use a short-lived JWT fetched per project. Vercel needed a
 * single bearer token for everything, which is why the Vercel client has no
 * notion of scope and this one does.
 *
 * Everything also arrives wrapped: Cloudflare answers `{ success, errors,
 * messages, result }` and puts a 200 on failures. Unwrapping that is the
 * client's job, so nothing above it has to know.
 */

import type { Effect } from "effect"
import { Schema } from "effect"
import { pagesLatestStage } from "./status.js"

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    message: Schema.String,
    operation: Schema.String,
    statusCode: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
    retryAfterMs: Schema.optional(Schema.Number)
  }
) {}

/** The fields this adapter reads off a Pages project. */
export const pagesProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})
export type PagesProject = typeof pagesProject.Type

/**
 * A Pages deployment.
 *
 * `latest_stage` is the whole state: a stage and a status, where only
 * `deploy/success` means live. `url` is present once there is one.
 */
export const pagesDeployment = Schema.Struct({
  id: Schema.String,
  url: Schema.optional(Schema.String),
  project_name: Schema.optional(Schema.String),
  latest_stage: pagesLatestStage,
  is_skipped: Schema.optional(Schema.Boolean)
})
export type PagesDeployment = typeof pagesDeployment.Type

/** One file as the asset upload endpoint wants it. */
export interface AssetUpload {
  /** The blake3 hash, which is also the key the manifest points at. */
  readonly key: string
  /** Base64 of the file's bytes. */
  readonly value: string
  readonly metadata: { readonly contentType: string }
  readonly base64: true
}

export interface CloudflareClient {
  readonly createProject: (name: string) => Effect.Effect<PagesProject, CloudflareApiError>
  readonly getProject: (name: string) => Effect.Effect<PagesProject, CloudflareApiError>
  readonly deleteProject: (name: string) => Effect.Effect<void, CloudflareApiError>
  readonly getDeployment: (
    projectName: string,
    deploymentId: string
  ) => Effect.Effect<PagesDeployment, CloudflareApiError>

  /** A short-lived JWT scoped to one project's asset store. */
  readonly uploadToken: (projectName: string) => Effect.Effect<string, CloudflareApiError>
  /** Which of these hashes Cloudflare does not already hold. */
  readonly checkMissing: (
    jwt: string,
    hashes: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<string>, CloudflareApiError>
  readonly uploadAssets: (
    jwt: string,
    payload: ReadonlyArray<AssetUpload>
  ) => Effect.Effect<void, CloudflareApiError>
  /** Keeps the uploaded hashes warm for the next deployment. */
  readonly upsertHashes: (
    jwt: string,
    hashes: ReadonlyArray<string>
  ) => Effect.Effect<void, CloudflareApiError>

  /** The manifest maps a leading-slash path to the hash holding its bytes. */
  readonly createDeployment: (
    projectName: string,
    manifest: Readonly<Record<string, string>>
  ) => Effect.Effect<PagesDeployment, CloudflareApiError>
}
