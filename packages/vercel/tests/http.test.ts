import { assert, describe, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, Redacted } from "effect"
import { makeVercelClient } from "../src/services/http.ts"

interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fetch that records the request and answers with whatever the test wants. */
const recordingFetch = (respond: () => Response) => {
  const calls: Array<Recorded> = []
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(respond())
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const client = (respond: () => Response, teamId?: string) => {
  const { calls, fetch } = recordingFetch(respond)
  return {
    calls,
    vercel: makeVercelClient({ token: "tok", fetch, ...(teamId !== undefined ? { teamId } : {}) })
  }
}

describe("createDeployment", () => {
  /**
   * The reason this adapter does not use @vercel/sdk. Without prebuilt=1
   * Vercel treats the uploaded files as source and builds them.
   */
  it.effect("sends prebuilt=1 and skipAutoDetectionConfirmation=1", () =>
    Effect.gen(function* () {
      const { calls, vercel } = client(() => ok({ id: "dpl_1", readyState: "QUEUED" }))

      yield* vercel.createDeployment({
        projectId: "prj_1",
        name: "alpha",
        files: [],
        target: "production"
      })

      const url = new URL(calls[0]!.url)
      assert.strictEqual(url.pathname, "/v13/deployments")
      assert.strictEqual(url.searchParams.get("prebuilt"), "1")
      assert.strictEqual(url.searchParams.get("skipAutoDetectionConfirmation"), "1")
    })
  )

  it.effect("sends the target and the file manifest in the body", () =>
    Effect.gen(function* () {
      const { calls, vercel } = client(() => ok({ id: "dpl_1", readyState: "QUEUED" }))

      yield* vercel.createDeployment({
        projectId: "prj_1",
        name: "alpha",
        files: [{ file: "index.html", sha: "abc", size: 3 }],
        target: "preview",
        meta: { releaseId: "rel_7" }
      })

      const body = JSON.parse(String(calls[0]!.init?.body))
      assert.strictEqual(body.project, "prj_1")
      assert.strictEqual(body.target, "preview")
      assert.deepStrictEqual(body.files, [{ file: "index.html", sha: "abc", size: 3 }])
      assert.deepStrictEqual(body.meta, { releaseId: "rel_7" })
    })
  )
})

describe("uploadFile", () => {
  /** The SDK mis-spells this header, which is why every upload through it fails. */
  it.effect("sends the sha as x-vercel-digest, spelled correctly", () =>
    Effect.gen(function* () {
      const { calls, vercel } = client(() => new Response("", { status: 200 }))

      yield* vercel.uploadFile("c22b5f91", new Uint8Array([1, 2, 3]))

      const headers = calls[0]!.init?.headers as Record<string, string>
      assert.strictEqual(new URL(calls[0]!.url).pathname, "/v2/files")
      assert.strictEqual(headers["x-vercel-digest"], "c22b5f91")
      assert.strictEqual(headers["Content-Length"], "3")
      assert.strictEqual(headers["Content-Type"], "application/octet-stream")
    })
  )
})

describe("failures", () => {
  it.effect("carries status, body and Retry-After off the response", () =>
    Effect.gen(function* () {
      const { vercel } = client(
        () =>
          new Response('{"error":"slow down"}', {
            status: 429,
            headers: { "retry-after": "30" }
          })
      )

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.strictEqual(error._tag, "VercelApiError")
      assert.strictEqual(error.statusCode, 429)
      assert.match(error.body ?? "", /slow down/)
      assert.strictEqual(error.retryAfterMs, 30_000)
      assert.strictEqual(error.operation, "getProject")
    })
  )

  it.effect("accepts an HTTP-date Retry-After as well as seconds", () =>
    Effect.gen(function* () {
      const when = new Date(Date.now() + 60_000).toUTCString()
      const { vercel } = client(
        () => new Response("", { status: 503, headers: { "retry-after": when } })
      )

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.isDefined(error.retryAfterMs)
      assert.isAbove(error.retryAfterMs!, 50_000)
      assert.isAtMost(error.retryAfterMs!, 61_000)
    })
  )

  it.effect("reports no status when the request never reached the server", () =>
    Effect.gen(function* () {
      const fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch
      const vercel = makeVercelClient({ token: "tok", fetch })

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.strictEqual(error.statusCode, undefined)
      assert.strictEqual(error.message, "ECONNREFUSED")
    })
  )
})

describe("team scoping", () => {
  it.effect("adds teamId to every request when configured", () =>
    Effect.gen(function* () {
      const { calls, vercel } = client(() => ok({ id: "prj_1", name: "alpha" }), "team_x")

      yield* vercel.getProject("prj_1")

      assert.strictEqual(new URL(calls[0]!.url).searchParams.get("teamId"), "team_x")
    })
  )

  it.effect("leaves it off when not configured", () =>
    Effect.gen(function* () {
      const { calls, vercel } = client(() => ok({ id: "prj_1", name: "alpha" }))

      yield* vercel.getProject("prj_1")

      assert.isFalse(calls[0]!.url.includes("teamId"))
    })
  )
})

describe("response validation", () => {
  /**
   * The failure this prevents: an unrecognised state used to reach
   * Deployment.make and throw a defect, so the first surprise from Vercel was
   * a stack trace rather than a diagnosis.
   */
  it.effect("rejects a readyState deploykit does not know, naming the body", () =>
    Effect.gen(function* () {
      const { vercel } = client(() => ok({ id: "dpl_1", readyState: "DELETED" }))

      const error = yield* Effect.flip(vercel.getDeployment("dpl_1"))

      assert.strictEqual(error._tag, "VercelApiError")
      assert.match(error.message, /does not recognise/)
      assert.match(error.body ?? "", /DELETED/, "the body says what arrived")
    })
  )

  it.effect("rejects a response missing a required field", () =>
    Effect.gen(function* () {
      const { vercel } = client(() => ok({ name: "alpha" }))

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.match(error.message, /does not recognise/)
    })
  )

  it.effect("accepts the optional fields being absent", () =>
    Effect.gen(function* () {
      const { vercel } = client(() => ok({ id: "dpl_1", readyState: "QUEUED" }))

      const deployment = yield* vercel.getDeployment("dpl_1")

      assert.strictEqual(deployment.url, undefined)
      assert.strictEqual(deployment.readyStateReason, undefined)
    })
  )

  it.effect("surfaces a body that is not JSON at all", () =>
    Effect.gen(function* () {
      const { vercel } = client(() => new Response("<html>gateway timeout</html>", { status: 200 }))

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.match(error.message, /not JSON/)
      assert.match(error.body ?? "", /gateway timeout/)
    })
  )

  it.effect("keeps the failure reason when Vercel gives one", () =>
    Effect.gen(function* () {
      const { vercel } = client(() =>
        ok({ id: "dpl_1", readyState: "ERROR", readyStateReason: "BUILD_FAILED" })
      )

      const deployment = yield* vercel.getDeployment("dpl_1")

      assert.strictEqual(deployment.readyStateReason, "BUILD_FAILED")
    })
  )
})

describe("token configuration", () => {
  it.effect("reads VERCEL_TOKEN when it is set", () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown({ VERCEL_TOKEN: "from-token" })
      const token = yield* Config.redacted("VERCEL_TOKEN").pipe(
        Config.orElse(() => Config.redacted("VERCEL_API_KEY")),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      )
      assert.strictEqual(Redacted.value(token), "from-token")
    })
  )

  it.effect("falls back to VERCEL_API_KEY", () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown({ VERCEL_API_KEY: "from-api-key" })
      const token = yield* Config.redacted("VERCEL_TOKEN").pipe(
        Config.orElse(() => Config.redacted("VERCEL_API_KEY")),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      )
      assert.strictEqual(Redacted.value(token), "from-api-key")
    })
  )

  it.effect("prefers VERCEL_TOKEN when both are set", () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown({
        VERCEL_TOKEN: "wins",
        VERCEL_API_KEY: "loses"
      })
      const token = yield* Config.redacted("VERCEL_TOKEN").pipe(
        Config.orElse(() => Config.redacted("VERCEL_API_KEY")),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      )
      assert.strictEqual(Redacted.value(token), "wins")
    })
  )
})
