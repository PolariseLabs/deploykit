import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { manifestFromDirectory, ProviderError } from "@deploykit/node"
import * as Vercel from "@deploykit/vercel"
import { publishVercel } from "./docs/vercel.ts"
import { publishEffect } from "./docs/effect.ts"
import { publishPages } from "./docs/pages.ts"
import { publishGeneratedConfig } from "./docs/generated-config.ts"
import { deployStoredArtifact } from "./docs/http-source.ts"
import { recoverPublish } from "./docs/recovery.ts"

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ file: Schema.String, sha: Schema.String, size: Schema.Number })
      ),
      autoAssignCustomDomains: Schema.Boolean
    })
  )
)
const directory = await mkdtemp(join(tmpdir(), "deploykit-docs-"))
const originalFetch = globalThis.fetch
const calls: string[] = []
const cache = new Set<string>()
let created = 0
const transport: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname
  if (path === "/v13/deployments") {
    const request = decode(String(init?.body))
    assert.equal(request.autoAssignCustomDomains, false)
    assert.ok(request.files.every(file => file.file.startsWith(".vercel/output/")))
    const missing = request.files.filter(file => !cache.has(file.sha)).map(file => file.sha)
    if (missing.length)
      return Response.json({ error: { code: "missing_files", missing } }, { status: 400 })
    created++
    return Response.json({ id: "dpl_docs", readyState: "READY", url: "docs.example.test" })
  }
  if (path === "/v2/files") {
    const digest = new Headers(init?.headers).get("x-vercel-digest")
    const bytes = await new Response(init?.body).arrayBuffer()
    assert.equal(digest, createHash("sha1").update(new Uint8Array(bytes)).digest("hex"))
    cache.add(digest!)
    return Response.json({})
  }
  if (path === "/v13/deployments/dpl_docs")
    return Response.json({ id: "dpl_docs", readyState: "READY", url: "docs.example.test" })
  if (path === "/v6/deployments")
    return Response.json({ deployments: [], pagination: { next: null } })
  throw new Error(`Unexpected provider request: ${path}`)
}
try {
  await mkdir(join(directory, ".vercel/output/static"), { recursive: true })
  await writeFile(join(directory, ".vercel/output/config.json"), '{"version":3}')
  await writeFile(join(directory, ".vercel/output/static/index.html"), "Hello from deploykit")
  const config = { token: "offline", fetch: transport }
  globalThis.fetch = async input => {
    assert.equal(String(input), "https://docs.example.test")
    calls.push("serving")
    return new Response("Hello from deploykit")
  }
  await publishVercel(config, {
    appId: "app",
    directory,
    operationId: "docs-proof",
    recordCreated: async deployment => {
      assert.equal(deployment.id, "dpl_docs")
      calls.push("receipt")
    },
    verify: async () => {
      calls.push("verification")
    }
  })
  assert.deepEqual(calls, ["receipt", "serving", "verification"])
  calls.length = 0
  await Effect.runPromise(
    publishEffect({
      appId: "app",
      directory,
      operationId: "effect-proof",
      recordCreated: () =>
        Effect.sync(() => {
          calls.push("receipt")
        })
    }).pipe(Effect.provide(Vercel.layer(config).pipe(Layer.provide(NodeFileSystem.layer))))
  )
  assert.deepEqual(calls, ["receipt", "serving"])
  const logo = join(directory, "logo.png")
  await writeFile(logo, new Uint8Array([1, 2, 3]))
  await publishGeneratedConfig(config, {
    appId: "app",
    operationId: "config-proof",
    title: "Generated",
    logoFile: logo
  })
  assert.ok(
    cache.has(
      createHash("sha1")
        .update(JSON.stringify({ title: "Generated" }))
        .digest("hex")
    )
  )
  await rm(logo)
  const manifest = await manifestFromDirectory(directory, { source: path => `artifact:${path}` })
  cache.clear()
  const reads: string[] = []
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname.slice(1)
    reads.push(path)
    return new Response(await readFile(join(directory, path)))
  }
  await deployStoredArtifact(config, {
    appId: "app",
    operationId: "stored-proof",
    manifest,
    signal: AbortSignal.timeout(10_000),
    resolveSource: async reference =>
      new URL(reference.slice("artifact:".length), "https://store.example.test/")
  })
  assert.equal(new Set(reads).size, 2)
  assert.equal(
    (
      await recoverPublish(config, {
        appId: "app",
        operationId: "lost",
        signal: AbortSignal.timeout(10_000)
      })
    ).state,
    "needs-review"
  )
  assert.equal(created, 4)
  const before = created
  let lostRequests = 0
  await assert.rejects(
    publishVercel(
      {
        token: "offline",
        fetch: async () => {
          lostRequests++
          throw new Error("lost response")
        }
      },
      {
        appId: "app",
        directory,
        operationId: "ambiguous",
        recordCreated: async () => {
          assert.fail("No receipt")
        },
        verify: async () => {
          assert.fail("No verification")
        }
      }
    ),
    (error: unknown) => error instanceof ProviderError && error.outcome === "unknown"
  )
  assert.equal(created, before)
  assert.equal(lostRequests, 1)
  const pagesDirectory = join(directory, "pages")
  await mkdir(pagesDirectory)
  await writeFile(join(pagesDirectory, "index.html"), "Hello")
  globalThis.fetch = async () => new Response("Hello")
  await publishPages(
    {
      apiToken: "offline",
      accountId: "test",
      previewBranch: "preview",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith("/projects/app"))
          return Response.json({
            success: true,
            result: { id: "app", name: "app", production_branch: "main" }
          })
        if (path.endsWith("upload-token"))
          return Response.json({ success: true, result: { jwt: "offline" } })
        if (path.endsWith("check-missing")) return Response.json({ success: true, result: [] })
        if (path.endsWith("deployments/pages"))
          return Response.json({
            success: true,
            result: {
              id: "pages",
              project_name: "app",
              url: "https://docs.example.test",
              latest_stage: { name: "deploy", status: "success" }
            }
          })
        if (path.endsWith("deployments")) {
          assert.ok(init?.body instanceof FormData)
          assert.equal(init.body.get("branch"), "preview")
          return Response.json({
            success: true,
            result: {
              id: "pages",
              project_name: "app",
              url: "https://docs.example.test",
              latest_stage: { name: "deploy", status: "success" }
            }
          })
        }
        throw new Error(`Unexpected Pages request: ${path}`)
      }
    },
    {
      appId: "app",
      directory: pagesDirectory,
      recordCreated: async result => {
        assert.equal(result.id, "pages")
      }
    }
  )
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
}
console.log(
  "Docs examples: receipt ordering, deferred activation, fingerprints, storage streams, ambiguous failures and Pages preview verified offline"
)
