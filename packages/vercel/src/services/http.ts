/**
 * The live VercelClient: plain fetch, no SDK, Effect all the way out.
 *
 * `fetch` is the only promise boundary, and it is crossed once in `request`.
 * Everything above it is an Effect with a typed failure, so a caller decides
 * what to retry from the status rather than by inspecting an exception.
 */

import { Effect, Option, Schema } from "effect"
import * as Provider from "@deploykit/core/provider"
import {
  VERCEL_API,
  VercelApiError,
  vercelDeployment,
  vercelProject,
  type VercelClient
} from "./client.js"

/** Bodies can be large; only the front of one is ever useful in an error. */
const MAX_BODY = 2000

/**
 * Retry-After is seconds or an HTTP date. Honouring it beats guessing, because
 * it is the server saying exactly how long to wait.
 */
const retryAfterMs = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

export interface VercelHttpConfig {
  readonly token: string
  /** Acts on behalf of a team, when the token is not already scoped to one. */
  readonly teamId?: string
  /** Override for testing against a recorded or local endpoint. */
  readonly baseUrl?: string
  /** Defaults to the global fetch, so a caller can supply their own. */
  readonly fetch?: typeof globalThis.fetch
  /**
   * Backoff for transient failures. Pass `{ attempts: 1 }` to disable retrying,
   * or a zero base delay in tests.
   */
  readonly retry?: Provider.RetryOptions
}

/** Built once: decoding is on the hot path for every poll. */
const decodeProject = Schema.decodeUnknownOption(vercelProject)
const decodeDeployment = Schema.decodeUnknownOption(vercelDeployment)

export const makeVercelClient = (config: VercelHttpConfig): VercelClient => {
  const baseUrl = config.baseUrl ?? VERCEL_API
  const doFetch = config.fetch ?? globalThis.fetch
  const auth = { Authorization: `Bearer ${config.token}` }

  /**
   * Reads and content-addressed uploads can be repeated safely. Creates
   * cannot: a 500 from createDeployment may mean the deployment exists, and
   * retrying would make a second one. Those retry on a throttle only, where
   * the provider rejected the request before acting on it.
   */
  const retrySafe = Provider.retryIdempotent(config.retry)
  const retryCreate = Provider.retryThrottleOnly(config.retry)

  const url = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params)
    if (config.teamId !== undefined) query.set("teamId", config.teamId)
    const search = query.toString()
    return `${baseUrl}${path}${search === "" ? "" : `?${search}`}`
  }

  /**
   * The single promise boundary. A thrown fetch means the request never got an
   * answer, so the error carries no status and `isTransient` treats it as
   * retryable; a non-ok response carries everything the server said.
   */
  type Retrier = <A, E extends Provider.RetryableFailure>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E>

  const request = (
    operation: string,
    href: string,
    init?: RequestInit,
    retry: Retrier = retrySafe
  ) =>
    retry(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => doFetch(href, init),
          catch: cause =>
            new VercelApiError({
              operation,
              message: cause instanceof Error ? cause.message : `${operation} could not be sent`
            })
        })

        if (!response.ok) {
          const body = yield* Effect.promise(() => response.text().catch(() => ""))
          return yield* new VercelApiError({
            operation,
            message: `${operation} failed: HTTP ${response.status}`,
            statusCode: response.status,
            body: body.slice(0, MAX_BODY),
            ...(() => {
              const ms = retryAfterMs(response.headers.get("retry-after"))
              return ms !== undefined ? { retryAfterMs: ms } : {}
            })()
          })
        }

        return response
      })
    )

  /**
   * Read the body and check its shape before anyone downstream trusts it.
   *
   * Without this the response was cast, so a field Vercel renamed became
   * `undefined` three layers away, and an unrecognised readyState reached
   * `Deployment.make` and threw a defect. Both are now one typed failure that
   * carries the body, so the answer is in the error rather than in a stack.
   */
  const json = <A>(
    operation: string,
    decode: (input: unknown) => Option.Option<A>,
    href: string,
    init?: RequestInit,
    retry: Retrier = retrySafe
  ): Effect.Effect<A, VercelApiError> =>
    request(operation, href, init, retry).pipe(
      Effect.flatMap(response =>
        Effect.gen(function* () {
          const text = yield* Effect.promise(() => response.text().catch(() => ""))

          const parsed = Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => undefined
          })
          const value = yield* parsed.pipe(
            Effect.mapError(
              () =>
                new VercelApiError({
                  operation,
                  message: `${operation} returned a body that is not JSON`,
                  statusCode: response.status,
                  body: text.slice(0, MAX_BODY)
                })
            )
          )

          const decoded = decode(value)
          if (Option.isNone(decoded)) {
            return yield* new VercelApiError({
              operation,
              message: `${operation} returned a body deploykit does not recognise`,
              statusCode: response.status,
              body: text.slice(0, MAX_BODY)
            })
          }
          return decoded.value
        })
      )
    )

  return {
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

    /**
     * The digest header is the point of this call: Vercel stores the bytes
     * under that sha and createDeployment then references it. The SDK
     * mis-spells this header, which is why uploads through it always fail.
     */
    uploadFile: (sha, bytes) =>
      request("uploadFile", url("/v2/files"), {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": sha,
          "Content-Length": String(bytes.byteLength)
        },
        body: bytes
      }).pipe(Effect.asVoid),

    /**
     * prebuilt=1 is what makes this a Build Output API deployment rather than a
     * source upload Vercel would try to build. skipAutoDetectionConfirmation
     * stops Vercel returning a 400 asking us to confirm a detected framework,
     * which an automated pipeline has nobody to answer.
     */
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
            ...(deployment.deploymentId !== undefined
              ? { deploymentId: deployment.deploymentId }
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
