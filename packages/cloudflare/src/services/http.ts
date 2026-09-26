import * as Telemetry from "@deploykit/core/telemetry"
import { fetchText, safeBody, retryAfter } from "@deploykit/core/http"

import type { Scope } from "effect"
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
const decodeDeployments = Schema.decodeUnknownOption(Schema.Array(pagesDeployment))
const decodeHashes = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeToken = Schema.decodeUnknownOption(Schema.Struct({ jwt: Schema.String }))

export interface CloudflareHttpConfig {
  readonly apiToken: string
  readonly accountId: string
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly retry?: Provider.RetryOptions
  readonly timeoutMs?: number
  readonly previewBranch?: string
  /** Shares request rate with other processes using the same token. */
  readonly gate?: Provider.RequestGate
}

export const makeCloudflareClient = (config: CloudflareHttpConfig): CloudflareClient => {
  const baseUrl = config.baseUrl ?? CLOUDFLARE_API
  const doFetch = config.fetch ?? globalThis.fetch
  const account = `/accounts/${encodeURIComponent(config.accountId)}`
  const gate = config.gate ?? Provider.openGate

  const retrySafe = Provider.retryIdempotent(config.retry)
  const retryCreate = <A, E>(effect: Effect.Effect<A, E>) => effect

  type Retrier = <A, E extends Provider.RetryableFailure>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E>

  const call = <A>(
    operation: string,
    decode: (input: unknown) => Option.Option<A>,
    path: string,
    init: RequestInit | Effect.Effect<RequestInit, never, Scope.Scope>,
    retry: Retrier = retrySafe
  ): Effect.Effect<A, CloudflareApiError> =>
    retry(
      Telemetry.observe(
        "cloudflare",
        operation,
        Effect.scoped(
          Effect.gen(function* () {
            const options = Effect.isEffect(init) ? yield* init : init
            yield* gate.acquire(operation)
            const { response, text } = yield* fetchText(doFetch, `${baseUrl}${path}`, options).pipe(
              Effect.mapError(
                () =>
                  new CloudflareApiError({ operation, message: `${operation} transport failed` })
              )
            )
            if (response.status === 429)
              yield* gate.backoff(retryAfter(response.headers.get("retry-after")) ?? 1000)
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
                ...(response.headers.get("cf-ray") === null
                  ? {}
                  : { requestId: response.headers.get("cf-ray")! }),
                body: safeBody(text),
                ...(() => {
                  const ms = retryAfter(response.headers.get("retry-after"))
                  return ms !== undefined ? { retryAfterMs: ms } : {}
                })()
              })
            }

            if (!response.ok || !wrapped.value.success) {
              const errors = wrapped.value.errors ?? []
              return yield* new CloudflareApiError({
                operation,
                message: `${operation} failed: HTTP ${response.status}`,
                ...(errors[0]?.code === undefined ? {} : { code: String(errors[0].code) }),
                statusCode: response.status,
                ...(response.headers.get("cf-ray") === null
                  ? {}
                  : { requestId: response.headers.get("cf-ray")! }),
                body: safeBody(text),
                // The status says 200, so nothing downstream could tell.
                ...(isTransientFailure(errors) ? { transient: true } : {}),
                ...(() => {
                  const ms = retryAfter(response.headers.get("retry-after"))
                  return ms !== undefined ? { retryAfterMs: ms } : {}
                })()
              })
            }

            const value = decode(wrapped.value.result)
            if (Option.isNone(value)) {
              return yield* new CloudflareApiError({
                operation,
                message: `${operation} returned a result deploykit does not recognise`,
                ...(operation === "createDeployment" &&
                typeof wrapped.value.result === "object" &&
                wrapped.value.result !== null &&
                "id" in wrapped.value.result &&
                typeof wrapped.value.result.id === "string"
                  ? { deploymentId: wrapped.value.result.id }
                  : {}),
                statusCode: response.status,
                ...(response.headers.get("cf-ray") === null
                  ? {}
                  : { requestId: response.headers.get("cf-ray")! }),
                body: safeBody(text)
              })
            }
            return value.value
          })
        )
      )
    ).pipe(
      Effect.timeout(config.timeoutMs ?? 30000),
      Effect.catchTag(
        "TimeoutError",
        () => new CloudflareApiError({ operation, message: `${operation} deadline exceeded` })
      )
    )

  const json = (token: string, body: unknown): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })

  const auth = { Authorization: `Bearer ${config.apiToken}` }
  const ignored = Schema.decodeUnknownOption(Schema.Unknown)

  return {
    ...(config.previewBranch === undefined ? {} : { previewBranch: config.previewBranch }),
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

    listDeployments: (projectName, { env, perPage }) =>
      call(
        "listDeployments",
        decodeDeployments,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/deployments?${new URLSearchParams(
          { per_page: String(perPage), ...(env === undefined ? {} : { env }) }
        )}`,
        { headers: auth }
      ),

    deleteDeployment: (projectName, deploymentId) =>
      call(
        "deleteDeployment",
        ignored,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}`,
        { method: "DELETE", headers: auth }
      ).pipe(Effect.asVoid),

    rollbackDeployment: (projectName, deploymentId) =>
      call(
        "rollbackDeployment",
        decodeDeployment,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
        { method: "POST", headers: auth }
      ),

    uploadToken: projectName =>
      call(
        "uploadToken",
        decodeToken,
        `${account}/pages/projects/${encodeURIComponent(projectName)}/upload-token`,
        { headers: auth }
      ).pipe(Effect.map(result => result.jwt)),

    checkMissing: (jwt, hashes) =>
      call("checkMissing", decodeHashes, "/pages/assets/check-missing", json(jwt, { hashes })),

    uploadAssets: (jwt, payload) =>
      call("uploadAssets", ignored, "/pages/assets/upload", json(jwt, payload)).pipe(Effect.asVoid),

    uploadAssetStream: (jwt, byteLength, open) =>
      call(
        "uploadAssets",
        ignored,
        "/pages/assets/upload",
        open.pipe(
          Effect.map(body => ({
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
              "Content-Length": String(byteLength)
            },
            body,
            duplex: "half"
          }))
        )
      ).pipe(Effect.asVoid),

    upsertHashes: (jwt, hashes) =>
      call("upsertHashes", ignored, "/pages/assets/upsert-hashes", json(jwt, { hashes })).pipe(
        Effect.asVoid
      ),

    createDeployment: (projectName, manifest, extras) => {
      const form = new FormData()
      form.append("manifest", JSON.stringify(manifest))
      if (extras?.branch !== undefined) form.append("branch", extras.branch)
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
