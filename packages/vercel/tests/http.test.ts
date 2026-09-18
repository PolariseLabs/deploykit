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

/** Retry off by default: these tests assert on one request, not on the policy. */
const client = (respond: () => Response, teamId?: string) => {
  const { calls, fetch } = recordingFetch(respond)
  return {
    calls,
    vercel: makeVercelClient({
      token: "tok",
      fetch,
      retry: { attempts: 1 },
      ...(teamId !== undefined ? { teamId } : {})
    })
  }
}

/** Retry on, with no waiting, so attempt counts are testable instantly. */
const retryingClient = (respond: () => Response, attempts: number) => {
  const { calls, fetch } = recordingFetch(respond)
  return {
    calls,
    vercel: makeVercelClient({ token: "tok", fetch, retry: { attempts, baseDelay: 0 } })
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
      const vercel = makeVercelClient({ token: "tok", fetch, retry: { attempts: 1 } })

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

describe("retry", () => {
  it.effect("retries a read through a 503 and succeeds", () =>
    Effect.gen(function* () {
      let call = 0
      const { calls, vercel } = retryingClient(() => {
        call += 1
        return call < 3 ? new Response("", { status: 503 }) : ok({ id: "prj_1", name: "alpha" })
      }, 4)

      const project = yield* vercel.getProject("prj_1")

      assert.strictEqual(project.id, "prj_1")
      assert.strictEqual(calls.length, 3, "two failures then a success")
    })
  )

  it.effect("gives up after the configured attempts", () =>
    Effect.gen(function* () {
      const { calls, vercel } = retryingClient(() => new Response("", { status: 500 }), 3)

      const error = yield* Effect.flip(vercel.getProject("prj_1"))

      assert.strictEqual(error.statusCode, 500)
      assert.strictEqual(calls.length, 3, "the first attempt plus two retries")
    })
  )

  it.effect("does not retry a 404, which will never become a 200", () =>
    Effect.gen(function* () {
      const { calls, vercel } = retryingClient(() => new Response("", { status: 404 }), 4)

      yield* Effect.flip(vercel.getProject("prj_1"))

      assert.strictEqual(calls.length, 1)
    })
  )

  it.effect("does not retry a 400: our request is wrong, repeating will not fix it", () =>
    Effect.gen(function* () {
      const { calls, vercel } = retryingClient(() => new Response("", { status: 400 }), 4)

      yield* Effect.flip(vercel.uploadFile("abc", new Uint8Array([1])))

      assert.strictEqual(calls.length, 1)
    })
  )

  it.effect("retries an upload, because content-addressed writes repeat safely", () =>
    Effect.gen(function* () {
      let call = 0
      const { calls, vercel } = retryingClient(() => {
        call += 1
        return call < 2 ? new Response("", { status: 429 }) : new Response("", { status: 200 })
      }, 4)

      yield* vercel.uploadFile("abc", new Uint8Array([1]))

      assert.strictEqual(calls.length, 2)
    })
  )

  /**
   * The distinction that matters. A 500 from a create may mean it succeeded
   * and the response was lost, so retrying risks a duplicate project. A 429
   * carries no such doubt: the request was rejected before it did anything.
   */
  it.effect("does NOT retry createProject on a 500", () =>
    Effect.gen(function* () {
      const { calls, vercel } = retryingClient(() => new Response("", { status: 500 }), 4)

      yield* Effect.flip(vercel.createProject("alpha"))

      assert.strictEqual(calls.length, 1, "a duplicate project is worse than a surfaced error")
    })
  )

  it.effect("does retry createProject on a 429", () =>
    Effect.gen(function* () {
      let call = 0
      const { calls, vercel } = retryingClient(() => {
        call += 1
        return call < 2 ? new Response("", { status: 429 }) : ok({ id: "prj_1", name: "alpha" })
      }, 4)

      const project = yield* vercel.createProject("alpha")

      assert.strictEqual(project.id, "prj_1")
      assert.strictEqual(calls.length, 2)
    })
  )

  /**
   * Retry-After must beat the computed backoff, or a throttled publish waits
   * on a guess while the provider has already said exactly how long. Proved by
   * setting a base delay so large that using it would blow the timeout.
   */
  it.effect("honours Retry-After instead of the exponential guess", () =>
    Effect.gen(function* () {
      let call = 0
      const fetch = (() => {
        call += 1
        return Promise.resolve(
          call < 2
            ? new Response("", { status: 429, headers: { "retry-after": "0" } })
            : new Response(JSON.stringify({ id: "prj_1", name: "alpha" }), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
        )
      }) as typeof globalThis.fetch

      const vercel = makeVercelClient({
        token: "tok",
        fetch,
        retry: { attempts: 3, baseDelay: "10 seconds" }
      })

      const started = Date.now()
      const project = yield* vercel.getProject("prj_1")
      const elapsed = Date.now() - started

      assert.strictEqual(project.id, "prj_1")
      assert.isBelow(elapsed, 1000, `Retry-After ignored: waited ${elapsed}ms`)
    })
  )

  it.effect("does NOT retry createDeployment on a 503", () =>
    Effect.gen(function* () {
      const { calls, vercel } = retryingClient(() => new Response("", { status: 503 }), 4)

      yield* Effect.flip(
        vercel.createDeployment({
          projectId: "prj_1",
          name: "alpha",
          files: [],
          target: "production"
        })
      )

      assert.strictEqual(calls.length, 1, "a duplicate deployment is worse than a surfaced error")
    })
  )
})
