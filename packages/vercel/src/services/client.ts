/**
 * The slice of Vercel's HTTP API this adapter uses.
 *
 * Deliberately not `@vercel/sdk`. Three reasons, in order of what they cost:
 *
 * 1. The SDK cannot express a prebuilt deployment. `prebuilt` appears nowhere
 *    in its request types, and a deployment created without it is treated as
 *    source and built, which is the opposite of what an artifact-first SDK
 *    wants.
 * 2. Its `uploadFile` has been observed to name the digest header with literal
 *    quotes, so every upload fails with `invalid_digest`.
 * 3. It is 51 MB across ~1,000 files and depends on zod, which is dead weight
 *    beside Effect Schema and too much for a serverless bundle.
 *
 * An interface rather than a concrete client, so a test supplies a stub with
 * no network and no casting.
 */

import type { Effect } from "effect"
import { Schema } from "effect"

export const VERCEL_API = "https://api.vercel.com"

/**
 * A Vercel call that failed, with everything needed to decide what to do next.
 *
 * A tagged error rather than a thrown Error so it travels in the Effect error
 * channel and a caller can `catchTag` on it. `statusCode` is absent when the
 * request never got an answer at all, which is itself the most retryable case.
 */
export class VercelApiError extends Schema.TaggedError<VercelApiError>()("VercelApiError", {
  message: Schema.String,
  operation: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.String),
  retryAfterMs: Schema.optional(Schema.Number)
}) {}

/**
 * The deployment states Vercel reports.
 *
 * A closed set, validated on the way in. A state we do not recognise becomes a
 * decode failure naming the body, which is the honest answer: treating it as
 * queued silently makes a deployment that never settles, and passing it
 * through makes `Deployment.make` throw a defect.
 */
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
  name: Schema.String
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
  /** Continues an existing deployment rather than starting a new one. */
  readonly deploymentId?: string
}

/**
 * Every call returns an Effect carrying a typed failure, so a caller can retry
 * on a status without unwrapping an exception, and a stub is an ordinary object
 * with no casting.
 */
/**
 * Who may open a deployment.
 *
 * A team with deployment protection on by default makes every project it
 * creates unreachable by end users, which is wrong for an app you are
 * deploying on a customer's behalf. Vercel models this per project, so it is
 * set per project.
 */
export type ProjectAccess =
  | { readonly _tag: "Public" }
  | { readonly _tag: "VercelAuth" }
  | { readonly _tag: "Password"; readonly password: string }

/**
 * The SHAs Vercel says it does not hold, pulled off a rejected createDeployment.
 *
 * Vercel answers a manifest referencing bytes it has never seen with an error
 * listing them, either at `error.missing` or `missing`. A first publish often
 * rejects with no list at all, which means "I have none of these".
 */
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
  readonly createProject: (name: string) => Effect.Effect<VercelProjectLike, VercelApiError>
  readonly getProject: (idOrName: string) => Effect.Effect<VercelProjectLike, VercelApiError>
  readonly deleteProject: (idOrName: string) => Effect.Effect<void, VercelApiError>
  /** POST /v2/files. The digest is the sha1 of the bytes, in hex. */
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
