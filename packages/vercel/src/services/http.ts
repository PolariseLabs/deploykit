import { makeUploadThrottle, type UploadThrottle } from "./throttle.js"
import * as Telemetry from "@deploykit/core/telemetry"
import { fetchText, safeBody, retryAfter, responseCode } from "@deploykit/core/http"

import type { Scope } from "effect"
import { Clock, Effect, Option, Schema } from "effect"
import * as Provider from "@deploykit/core/provider"
import {
  VERCEL_API,
  VercelApiError,
  vercelDeployment,
  vercelReadyState,
  vercelProject,
  type VercelClient
} from "./client.js"

export interface VercelHttpConfig {
  readonly token: string
  /** Acts on behalf of a team, when the token is not already scoped to one. */
  readonly teamId?: string
  /** Override for testing against a recorded or local endpoint. */
  readonly baseUrl?: string
  /** Defaults to the global fetch, so a caller can supply their own. */
  readonly fetch?: typeof globalThis.fetch

  /** Shared by uploads and retries through this client; omitted preserves unpaced uploads. */
  readonly uploadThrottle?: UploadThrottle
  readonly retry?: Provider.RetryOptions
  readonly timeoutMs?: number
  /** Shares request rate with other processes using the same token. */
  readonly gate?: Provider.RequestGate
}

/** Built once: decoding is on the hot path for every poll. */
const decodeProject = Schema.decodeUnknownOption(vercelProject)
const decodeDeployment = Schema.decodeUnknownOption(vercelDeployment)
const isReadyState = Schema.is(vercelReadyState)

export const makeVercelClient = (config: VercelHttpConfig): VercelClient => {
  const baseUrl = config.baseUrl ?? VERCEL_API
  const doFetch = config.fetch ?? globalThis.fetch
  const auth = { Authorization: `Bearer ${config.token}` }

  const throttle = makeUploadThrottle(config.uploadThrottle)
  const gate = config.gate ?? Provider.openGate
  const retrySafe = Provider.retryIdempotent(config.retry)
  const retryCreate = <A, E>(effect: Effect.Effect<A, E>) => effect

  const url = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params)
    if (config.teamId !== undefined) query.set("teamId", config.teamId)
    const search = query.toString()
    return `${baseUrl}${path}${search === "" ? "" : `?${search}`}`
  }

  type Retrier = <A, E extends Provider.RetryableFailure>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E>
  const request = (
    operation: string,
    href: string,
    init?: RequestInit | Effect.Effect<RequestInit, never, Scope.Scope>,
    retry: Retrier = retrySafe
  ) => {
    const attempt = Telemetry.observe(
      "vercel",
      operation,
      Effect.scoped(
        Effect.gen(function* () {
          const options = Effect.isEffect(init) ? yield* init : init
          yield* gate.acquire(operation)
          return yield* fetchText(doFetch, href, options)
        })
      ).pipe(
        Effect.mapError(
          () => new VercelApiError({ operation, message: `${operation} transport failed` })
        ),
        Effect.flatMap(({ response, text }) =>
          Effect.gen(function* () {
            const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000
            const now = yield* Clock.currentTimeMillis
            const retryAfterMs =
              retryAfter(response.headers.get("retry-after")) ??
              (response.status === 429 && Number.isFinite(reset) && reset > now
                ? reset - now
                : undefined)
            const diagnostic = {
              operation,
              statusCode: response.status,
              ...(responseCode(text) === undefined ? {} : { code: responseCode(text)! }),
              ...(response.headers.get("x-vercel-id") === null
                ? {}
                : { requestId: response.headers.get("x-vercel-id")! }),
              ...(retryAfterMs === undefined ? {} : { retryAfterMs })
            }
            if (response.status === 429) yield* gate.backoff(retryAfterMs ?? 1000)
            if (operation === "uploadFile" && response.status === 429) {
              yield* throttle.cooldown(retryAfterMs ?? 1000)
            }
            return yield* response.ok
              ? Effect.succeed({ text, diagnostic })
              : Effect.fail(
                  new VercelApiError({
                    ...diagnostic,
                    message: `${operation} failed: HTTP ${response.status}`,
                    body: safeBody(text)
                  })
                )
          })
        )
      )
    )
    return Effect.andThen(
      operation === "uploadFile" ? throttle.validate : Effect.void,
      retry(operation === "uploadFile" ? throttle.run(attempt) : attempt)
    ).pipe(
      Effect.timeout(config.timeoutMs ?? 30000),
      Effect.catchTag(
        "TimeoutError",
        () => new VercelApiError({ operation, message: `${operation} deadline exceeded` })
      )
    )
  }

  const json = <A>(
    operation: string,
    decode: (input: unknown) => Option.Option<A>,
    href: string,
    init?: RequestInit,
    retry: Retrier = retrySafe
  ): Effect.Effect<A, VercelApiError> =>
    request(operation, href, init, retry).pipe(
      Effect.flatMap(({ text, diagnostic }) =>
        Effect.gen(function* () {
          const value = yield* Effect.try({
            try: (): unknown => JSON.parse(text),
            catch: () =>
              new VercelApiError({
                ...diagnostic,
                message: `${operation} returned a body that is not JSON`
              })
          })
          const decoded = decode(value)
          if (Option.isNone(decoded))
            return yield* new VercelApiError({
              ...diagnostic,
              ...(operation === "createDeployment" &&
              typeof value === "object" &&
              value !== null &&
              "id" in value &&
              typeof value.id === "string"
                ? { deploymentId: value.id }
                : {}),
              message: `${operation} returned a body deploykit does not recognise`
            })
          return decoded.value
        })
      )
    )

  return {
    promoteDeployment: (projectId, deploymentId) =>
      request(
        "activateDeployment",
        url(
          `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`
        ),
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}"
        },
        retryCreate
      ).pipe(Effect.asVoid),
    findDeployments: (projectId, operationId) =>
      json(
        "listDeployments",
        Schema.decodeUnknownOption(
          Schema.Struct({
            deployments: Schema.Array(
              Schema.Struct({
                uid: Schema.String,
                name: Schema.String,
                readyState: vercelReadyState,
                url: Schema.optional(Schema.String),
                meta: Schema.optional(Schema.Record(Schema.String, Schema.String))
              })
            ),
            pagination: Schema.Struct({ next: Schema.NullOr(Schema.Number) })
          })
        ),
        url("/v6/deployments", {
          projectId,
          "meta-deploykitOperationId": operationId,
          limit: "100"
        }),
        { headers: auth }
      ).pipe(
        Effect.map(result => ({
          complete: result.pagination.next === null,
          deployments: result.deployments
            .filter(item => item.meta?.deploykitOperationId === operationId)
            .map(item => ({
              id: item.uid,
              name: item.name,
              readyState: item.readyState,
              projectId,
              ...(item.url === undefined ? {} : { url: item.url })
            }))
        }))
      ),
    listDeployments: (projectId, { target, limit }) =>
      json(
        "listDeployments",
        Schema.decodeUnknownOption(
          Schema.Struct({
            deployments: Schema.Array(
              Schema.Struct({
                uid: Schema.String,
                name: Schema.String,
                // A string, not the ready-state literals: DELETED entries are skipped, not fatal.
                readyState: Schema.String,
                url: Schema.optional(Schema.NullOr(Schema.String)),
                target: Schema.optional(Schema.NullOr(Schema.String))
              })
            )
          })
        ),
        url("/v7/deployments", {
          projectId,
          limit: String(limit),
          ...(target === undefined ? {} : { target })
        }),
        { headers: auth }
      ).pipe(
        Effect.map(result =>
          result.deployments.flatMap(item =>
            isReadyState(item.readyState) && (target !== "preview" || item.target !== "production")
              ? [
                  {
                    id: item.uid,
                    name: item.name,
                    readyState: item.readyState,
                    projectId,
                    ...(item.target == null ? {} : { target: item.target }),
                    ...(item.url == null ? {} : { url: item.url })
                  }
                ]
              : []
          )
        )
      ),
    deleteDeployment: deploymentId =>
      request("deleteDeployment", url(`/v13/deployments/${encodeURIComponent(deploymentId)}`), {
        method: "DELETE",
        headers: auth
      }).pipe(Effect.asVoid),
    createProject: name =>
      json(
        "createProject",
        decodeProject,
        url("/v11/projects"),
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        },
        retryCreate
      ),

    getProject: idOrName =>
      json("getProject", decodeProject, url(`/v9/projects/${encodeURIComponent(idOrName)}`), {
        headers: auth
      }),

    deleteProject: idOrName =>
      request("deleteProject", url(`/v9/projects/${encodeURIComponent(idOrName)}`), {
        method: "DELETE",
        headers: auth
      }).pipe(Effect.asVoid),

    uploadFile: (sha, bytes) =>
      request("uploadFile", url("/v2/files"), {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": sha
        },
        body: bytes
      }).pipe(Effect.asVoid),

    uploadFileStream: (sha, byteLength, open) =>
      request(
        "uploadFile",
        url("/v2/files"),
        open.pipe(
          Effect.map(body => ({
            method: "POST",
            headers: {
              ...auth,
              "Content-Type": "application/octet-stream",
              "x-vercel-digest": sha,
              "Content-Length": String(byteLength)
            },
            body,
            duplex: "half"
          }))
        )
      ).pipe(Effect.asVoid),

    createDeployment: deployment =>
      json(
        "createDeployment",
        decodeDeployment,
        url("/v13/deployments", { prebuilt: "1", skipAutoDetectionConfirmation: "1" }),
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: deployment.name,
            project: deployment.projectId,
            target: deployment.target,
            files: deployment.files,
            ...(deployment.meta !== undefined ? { meta: deployment.meta } : {}),
            ...(deployment.autoAssignCustomDomains !== undefined
              ? { autoAssignCustomDomains: deployment.autoAssignCustomDomains }
              : {})
          })
        },
        retryCreate
      ),

    setProjectAccess: (idOrName, access) => {
      const body =
        access._tag === "Public"
          ? { ssoProtection: null, passwordProtection: null }
          : access._tag === "VercelAuth"
            ? { ssoProtection: { deploymentType: "all" }, passwordProtection: null }
            : {
                ssoProtection: null,
                passwordProtection: { deploymentType: "all", password: access.password }
              }

      return request("setProjectAccess", url(`/v9/projects/${encodeURIComponent(idOrName)}`), {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).pipe(Effect.asVoid)
    },

    getDeployment: idOrUrl =>
      json(
        "getDeployment",
        decodeDeployment,
        url(`/v13/deployments/${encodeURIComponent(idOrUrl)}`),
        {
          headers: auth
        }
      )
  }
}
