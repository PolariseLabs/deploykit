import type { Effect, Scope } from "effect"
import { Schema } from "effect"
import { pagesLatestStage } from "./status.js"

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    message: Schema.String,
    operation: Schema.String,
    requestId: Schema.optional(Schema.String),
    deploymentId: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    statusCode: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
    retryAfterMs: Schema.optional(Schema.Number),
    transient: Schema.optional(Schema.Boolean)
  }
) {}

export const isTransientFailure = (
  errors: ReadonlyArray<{ readonly code?: number | undefined; readonly message: string }>
): boolean =>
  errors.some(
    error =>
      error.code === 8000000 ||
      error.message.includes("An unknown error occurred") ||
      error.message.includes("internal error")
  )

/** The fields this adapter reads off a Pages project. */
export const pagesProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  production_branch: Schema.optional(Schema.String),
  /** The deployment serving production right now. */
  canonical_deployment: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String })))
})
export type PagesProject = typeof pagesProject.Type

export const pagesDeployment = Schema.Struct({
  id: Schema.String,
  url: Schema.optional(Schema.String),
  project_name: Schema.optional(Schema.String),
  latest_stage: pagesLatestStage,
  is_skipped: Schema.optional(Schema.Boolean),
  environment: Schema.optional(Schema.String)
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

/** Parts of a deployment that are not assets. */
export interface DeploymentExtras {
  readonly branch?: string
  /** A serialised Workers upload form, from `workerBundle`. */
  readonly workerBundle?: Blob
  /** Which paths the Worker handles; without it, it handles everything. */
  readonly routes?: unknown
  readonly headers?: string
  readonly redirects?: string
}

export interface CloudflareClient {
  readonly previewBranch?: string
  readonly createProject: (name: string) => Effect.Effect<PagesProject, CloudflareApiError>
  readonly getProject: (name: string) => Effect.Effect<PagesProject, CloudflareApiError>
  readonly deleteProject: (name: string) => Effect.Effect<void, CloudflareApiError>
  readonly getDeployment: (
    projectName: string,
    deploymentId: string
  ) => Effect.Effect<PagesDeployment, CloudflareApiError>

  /** One page of a project's deployments, newest first. */
  readonly listDeployments?: (
    projectName: string,
    options: { readonly env?: "production" | "preview"; readonly perPage: number }
  ) => Effect.Effect<ReadonlyArray<PagesDeployment>, CloudflareApiError>
  readonly deleteDeployment?: (
    projectName: string,
    deploymentId: string
  ) => Effect.Effect<void, CloudflareApiError>
  /** Point production back at an earlier successful production deployment. */
  readonly rollbackDeployment?: (
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
  readonly uploadAssetStream?: (
    jwt: string,
    byteLength: number,
    open: Effect.Effect<ReadableStream<Uint8Array>, never, Scope.Scope>
  ) => Effect.Effect<void, CloudflareApiError>
  readonly uploadAssets: (
    jwt: string,
    payload: ReadonlyArray<AssetUpload>
  ) => Effect.Effect<void, CloudflareApiError>
  /** Keeps the uploaded hashes warm for the next deployment. */
  readonly upsertHashes: (
    jwt: string,
    hashes: ReadonlyArray<string>
  ) => Effect.Effect<void, CloudflareApiError>

  readonly createDeployment: (
    projectName: string,
    manifest: Readonly<Record<string, string>>,
    extras?: DeploymentExtras
  ) => Effect.Effect<PagesDeployment, CloudflareApiError>
}
