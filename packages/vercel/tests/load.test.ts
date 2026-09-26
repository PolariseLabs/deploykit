import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import type { Provider } from "@deploykit/core"
import { Artifact, Deploykit, Entry } from "@deploykit/core"
import { layerWith, makeVercelClient } from "../src/index.ts"

const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex")

/**
 * A fake Vercel that rate-limits uploads: every fourth upload gets a 429.
 * It runs the real negotiation (missing_files, then create) so retries and
 * throttling are exercised end to end, and counts what it saw.
 */
const rateLimitedVercel = () => {
  const stored = new Set<string>()
  const seen = { uploads: 0, throttled: 0, created: new Map<string, number>() }
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === "/v2/files") {
      seen.uploads++
      if (seen.uploads % 4 === 0) {
        seen.throttled++
        return new Response("{}", { status: 429, headers: { "retry-after": "0" } })
      }
      stored.add(sha1(new Uint8Array(init?.body as ArrayBuffer)))
      return new Response("{}")
    }
    const request = JSON.parse(String(init?.body)) as {
      name: string
      files: ReadonlyArray<{ sha: string }>
    }
    const missing = request.files.map(file => file.sha).filter(sha => !stored.has(sha))
    if (missing.length > 0)
      return Response.json({ error: { code: "missing_files", missing } }, { status: 400 })
    seen.created.set(request.name, (seen.created.get(request.name) ?? 0) + 1)
    return Response.json({
      id: `dpl_${request.name}`,
      projectId: request.name,
      readyState: "READY",
      target: "production"
    })
  }
  return { fetch, seen }
}

it.live("forty tenants deploying at once all finish under sustained 429s", () =>
  Effect.gen(function* () {
    const vercel = rateLimitedVercel()
    const gated = { acquired: 0, backoffs: 0 }
    const gate: Provider.RequestGate = {
      acquire: () => Effect.sync(() => void gated.acquired++),
      backoff: () => Effect.sync(() => void gated.backoffs++)
    }
    const client = makeVercelClient({
      token: "test",
      fetch: vercel.fetch,
      gate,
      uploadThrottle: "fast"
    })
    const tenants = Array.from({ length: 40 }, (_, index) => `tenant-${index}`)

    yield* Effect.forEach(
      tenants,
      tenant =>
        Effect.gen(function* () {
          const deploykit = yield* Deploykit.Deploykit
          const files = yield* Effect.forEach(
            Array.from({ length: 10 }, (_, n) => n),
            n => Entry.text(`page-${n}.html`, `${tenant} page ${n}`)
          )
          const deployment = yield* deploykit.deploy(tenant, yield* Artifact.make(files))
          assert.strictEqual(deployment.status, "deployed")
        }),
      { concurrency: 10 }
    ).pipe(
      Effect.provide(
        Deploykit.layer().pipe(
          Layer.provide(layerWith(client)),
          Layer.provide(NodeFileSystem.layer)
        )
      )
    )

    assert.isAbove(vercel.seen.throttled, 50, "the fake really did throttle")
    assert.strictEqual(vercel.seen.created.size, 40)
    assert.isTrue(
      [...vercel.seen.created.values()].every(count => count === 1),
      "no tenant's deployment was created twice"
    )
    assert.strictEqual(gated.backoffs, vercel.seen.throttled, "every 429 reached the gate")
    assert.isAtLeast(gated.acquired, vercel.seen.uploads, "every request asked the gate first")
  })
)
