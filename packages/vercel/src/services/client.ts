import type { Effect, Scope } from "effect"
import { Schema } from "effect"

export const VERCEL_API = "https://api.vercel.com"

export class VercelApiError extends Schema.TaggedError<VercelApiError>()("VercelApiError", {
  message: Schema.String,
  operation: Schema.String,
  requestId: Schema.optional(Schema.String),
  deploymentId: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.String),
  retryAfterMs: Schema.optional(Schema.Number)
}) {}

export const vercelReadyState = Schema.Literals([
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "READY",
  "ERROR",
  "CANCELED",
  "BLOCKED"
])
export type VercelReadyState = typeof vercelReadyState.Type

/** The fields this adapter reads off a Vercel deployment. */
export const vercelDeployment = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  readyState: vercelReadyState,
  target: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  url: Schema.optional(Schema.String),
  /** Why a failed deployment failed, when Vercel says. */
  readyStateReason: Schema.optional(Schema.String)
})
export type VercelDeploymentLike = typeof vercelDeployment.Type

/** The fields this adapter reads off a Vercel project. */
export const vercelProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  targets: Schema.optional(
    Schema.Struct({ production: Schema.optional(Schema.Struct({ id: Schema.String })) })
  )
})
export type VercelProjectLike = typeof vercelProject.Type

/** One entry of the manifest `createDeployment` is given. */
export interface VercelFileRef {
  readonly file: string
  readonly sha: string
  readonly size: number
}

export interface CreateDeploymentRequest {
  readonly projectId: string
  readonly name: string
  readonly files: ReadonlyArray<VercelFileRef>
  readonly target: "production" | "preview"
  /** Arbitrary metadata, for linking a deployment back to a release. */
  readonly meta?: Readonly<Record<string, string>>
  readonly autoAssignCustomDomains?: boolean
}

export type ProjectAccess =
  | { readonly _tag: "Public" }
  | { readonly _tag: "VercelAuth" }
  | { readonly _tag: "Password"; readonly password: string }

export const missingShas = (error: VercelApiError): ReadonlyArray<string> | undefined => {
  if (error.body === undefined) return undefined
  const parsed = ((): unknown => {
    try {
      return JSON.parse(error.body)
    } catch {
      return undefined
    }
  })()
  const candidate =
    (parsed as { error?: { missing?: unknown } } | undefined)?.error?.missing ??
    (parsed as { missing?: unknown } | undefined)?.missing
  return Array.isArray(candidate) && candidate.every(sha => typeof sha === "string")
    ? candidate
    : undefined
}

/** A manifest rejected because Vercel holds none of the referenced bytes. */
export const isMissingDigest = (error: VercelApiError): boolean =>
  error.body !== undefined &&
  (error.body.includes("invalid_digest") || error.body.includes("File digest missing"))

export interface VercelClient {
  readonly promoteDeployment?: (
    projectId: string,
    deploymentId: string
  ) => Effect.Effect<void, VercelApiError>
  readonly findDeployments?: (
    projectId: string,
    operationId: string
  ) => Effect.Effect<
    { readonly deployments: ReadonlyArray<VercelDeploymentLike>; readonly complete: boolean },
    VercelApiError
  >

  /** GET /v7/deployments for one project, newest first. Deleted deployments are left out. */
  readonly listDeployments?: (
    projectId: string,
    options: { readonly target?: "production" | "preview"; readonly limit: number }
  ) => Effect.Effect<ReadonlyArray<VercelDeploymentLike>, VercelApiError>
  readonly deleteDeployment?: (deploymentId: string) => Effect.Effect<void, VercelApiError>

  readonly createProject: (name: string) => Effect.Effect<VercelProjectLike, VercelApiError>
  readonly getProject: (idOrName: string) => Effect.Effect<VercelProjectLike, VercelApiError>
  readonly deleteProject: (idOrName: string) => Effect.Effect<void, VercelApiError>
  /** POST /v2/files. The digest is the sha1 of the bytes, in hex. */
  readonly uploadFileStream?: (
    sha: string,
    byteLength: number,
    open: Effect.Effect<ReadableStream<Uint8Array>, never, Scope.Scope>
  ) => Effect.Effect<void, VercelApiError>
  readonly uploadFile: (sha: string, bytes: Uint8Array) => Effect.Effect<void, VercelApiError>
  readonly createDeployment: (
    request: CreateDeploymentRequest
  ) => Effect.Effect<VercelDeploymentLike, VercelApiError>
  readonly getDeployment: (idOrUrl: string) => Effect.Effect<VercelDeploymentLike, VercelApiError>
  readonly setProjectAccess: (
    idOrName: string,
    access: ProjectAccess
  ) => Effect.Effect<void, VercelApiError>
}
