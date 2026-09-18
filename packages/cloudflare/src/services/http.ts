/**
 * The live CloudflareClient: fetch, no SDK, Effect all the way out.
 *
 * The one structural difference from the Vercel client is the envelope.
 * Cloudflare answers `{ success, errors, result }` and will return HTTP 200
 * with `success: false`, so checking the status code alone reports a failure
 * as a success. Unwrapping happens here once.
 */

import { Effect, Option, Schema } from "effect"
import * as Provider from "@deploykit/core/provider"
import {
  CLOUDFLARE_API,
  CloudflareApiError,
  isTransientFailure,
  pagesDeployment,
  pagesProject,
  type AssetUpload,
  type CloudflareClient
} from "./client.js"

const MAX_BODY = 2000

const envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.optional(Schema.Number), message: Schema.String }))
  ),
  result: Schema.Unknown
})
const decodeEnvelope = Schema.decodeUnknownOption(envelope)
const decodeProject = Schema.decodeUnknownOption(pagesProject)
const decodeDeployment = Schema.decodeUnknownOption(pagesDeployment)
const decodeHashes = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeToken = Schema.decodeUnknownOption(Schema.Struct({ jwt: Schema.String }))

const retryAfterMs = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

export interface CloudflareHttpConfig {
  readonly apiToken: string
  readonly accountId: string
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly retry?: Provider.RetryOptions
}

export const makeCloudflareClient = (config: CloudflareHttpConfig): CloudflareClient => {
  const baseUrl = config.baseUrl ?? CLOUDFLARE_API
  const doFetch = config.fetch ?? globalThis.fetch
  const account = `/accounts/${encodeURIComponent(config.accountId)}`

  const retrySafe = Provider.retryIdempotent(config.retry)
  const retryCreate = Provider.retryThrottleOnly(config.retry)

  type Retrier = <A, E extends Provider.RetryableFailure>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E>

  /**
   * One request, unwrapped. `success: false` is a failure whatever the status
   * code says, and the messages Cloudflare puts in `errors` are the only
   * useful part of the response when something is wrong.
   */
  const call = <A>(
    operation: string,
    decode: (input: unknown) => Option.Option<A>,
    path: string,
    init: RequestInit,
    retry: Retrier = retrySafe
  ): Effect.Effect<A, CloudflareApiError> =>
    retry(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => doFetch(`${baseUrl}${path}`, init),
          catch: cause =>
            new CloudflareApiError({
              operation,
              message: cause instanceof Error ? cause.message : `${operation} could not be sent`
            })
        })

        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        const parsed = ((): unknown => {
          try {
            return JSON.parse(text)
          } catch {
            return undefined
          }
        })()

        const wrapped = decodeEnvelope(parsed)
        if (Option.isNone(wrapped)) {
          return yield* new CloudflareApiError({
            operation,
            message: `${operation} returned a body deploykit does not recognise`,
            statusCode: response.status,
            body: text.slice(0, MAX_BODY),
            ...(() => {
              const ms = retryAfterMs(response.headers.get("retry-after"))
              return ms !== undefined ? { retryAfterMs: ms } : {}
            })()
          })
        }

        if (!wrapped.value.success) {
          const errors = wrapped.value.errors ?? []
          const detail = errors.map(e => e.message).join("; ")
          return yield* new CloudflareApiError({
            operation,
            message: `${operation} failed: ${detail || `HTTP ${response.status}`}`,
            statusCode: response.status,
            body: text.slice(0, MAX_BODY),
            // The status says 200, so nothing downstream could tell.
            ...(isTransientFailure(errors) ? { transient: true } : {}),
            ...(() => {
              const ms = retryAfterMs(response.headers.get("retry-after"))
              return ms !== undefined ? { retryAfterMs: ms } : {}
            })()
          })
        }

        const value = decode(wrapped.value.result)
        if (Option.isNone(value)) {
          return yield* new CloudflareApiError({
            operation,
            message: `${operation} returned a result deploykit does not recognise`,
            statusCode: response.status,
            body: text.slice(0, MAX_BODY)
          })
        }
        return value.value
      })
    )

  const json = (token: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })

  const auth = { Authorization: `Bearer ${config.apiToken}` }
  const ignored = Schema.decodeUnknownOption(Schema.Unknown)

  return {
    createProject: name =>
      call(
        "createProject",
        decodeProject,
        `${account}/pages/projects`,
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          // production_branch is required even for direct upload projects.
          body: JSON.stringify({ name, production_branch: "main" })
        },
        retryCreate
      ),

    getProject: name =>
      call("getProject", decodeProject, `${account}/pages/projects/${encodeURIComponent(name)}`, {
        headers: auth
      }),

    deleteProject: name =>
      call("deleteProject", ignored, `${account}/pages/projects/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: auth
      }).pipe(Effect.asVoid),

    getDeployment: (projectName, deploymentId) =>
      call(
        "getDeployment",
        decodeDeployment,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: auth }
      ),

    uploadToken: projectName =>
      call(
        "uploadToken",
        decodeToken,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/upload-token`,
        { headers: auth }
      ).pipe(Effect.map(result => result.jwt)),

    /**
     * Cloudflare answers the manifest-first question natively: hand it every
     * hash and it says which it does not hold. Vercel only tells you inside a
     * rejected deployment.
     */
    checkMissing: (jwt, hashes) =>
      call("checkMissing", decodeHashes, "/pages/assets/check-missing", json(jwt, { hashes })),

    uploadAssets: (jwt, payload) =>
      call("uploadAssets", ignored, "/pages/assets/upload", json(jwt, payload)).pipe(Effect.asVoid),

    upsertHashes: (jwt, hashes) =>
      call("upsertHashes", ignored, "/pages/assets/upsert-hashes", json(jwt, { hashes })).pipe(
        Effect.asVoid
      ),

    createDeployment: (projectName, manifest, extras) => {
      const form = new FormData()
      form.append("manifest", JSON.stringify(manifest))
      if (extras?.workerBundle !== undefined) {
        form.append("_worker.bundle", new File([extras.workerBundle], "_worker.bundle"))
      }
      if (extras?.routes !== undefined) {
        form.append("_routes.json", new File([JSON.stringify(extras.routes)], "_routes.json"))
      }
      if (extras?.headers !== undefined) {
        form.append("_headers", new File([extras.headers], "_headers"))
      }
      if (extras?.redirects !== undefined) {
        form.append("_redirects", new File([extras.redirects], "_redirects"))
      }
      return call(
        "createDeployment",
        decodeDeployment,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
        { method: "POST", headers: auth, body: form },
        retryCreate
      )
    }
  }
}

export type { AssetUpload }
