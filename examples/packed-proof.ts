import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Entry, Manifest, Provider, Source } from "@deploykit/core"
import {
  layerWith as vercelLayer,
  makeVercelClient,
  uploadThrottlePresets
} from "@deploykit/vercel"
import type { DeployRequestOptions } from "@deploykit/vercel"
import { makeStagingBudget } from "@deploykit/core/staging"
import { makeVercelControl } from "@deploykit/vercel/control"
import { layerWith as pagesLayer, pagesDigest } from "@deploykit/cloudflare"
import { makeCloudflareClient, makeCloudflareControl } from "@deploykit/cloudflare/control"
import { publishPreparedDirectory } from "./public-api.ts"
import { deployDirectory } from "./standalone.ts"
import { publishWorker, checkAndActivate } from "./coordinator-worker.ts"

const decodeCreate = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Array(
        Schema.Struct({ file: Schema.String, sha: Schema.String, size: Schema.Number })
      ),
      meta: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      autoAssignCustomDomains: Schema.optional(Schema.Boolean)
    })
  )
)
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), deployment: Provider.Deployment })
  )
)
const decodeHashes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ hashes: Schema.Array(Schema.String) }))
)
const decodeUploads = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ key: Schema.String })))
)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(`${directory}/.vercel/output/static`, { recursive: true })
  yield* fs.writeFileString(`${directory}/.vercel/output/static/index.html`, "hello")
  yield* fs.writeFileString(`${directory}/.vercel/output/config.json`, '{"version":3}')
  let active = "previous"
  let nextId = 0
  let loseResponse = false
  const created: Array<{ id: string; operationId: string | undefined }> = []
  const cached = new Set<string>()
  const uploadedBodies = new Map<string, Uint8Array>()
  const filesByDeployment = new Map<
    string,
    ReadonlyArray<{ file: string; sha: string; size: number }>
  >()
  const client = makeVercelClient({
    uploadThrottle: uploadThrottlePresets.fast,
    token: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === "/v13/deployments") {
        const request = decodeCreate(String(init?.body))
        assert.ok(request.files.some(file => file.file === ".vercel/output/config.json"))
        assert.ok(request.files.every(file => file.file.startsWith(".vercel/output/")))
        const missing = request.files
          .filter((file: { sha: string }) => !cached.has(file.sha))
          .map((file: { sha: string }) => file.sha)
        if (missing.length > 0)
          return Response.json({ error: { code: "missing_files", missing } }, { status: 400 })
        const id = `dpl_${++nextId}`
        filesByDeployment.set(id, request.files)
        created.push({ id, operationId: request.meta?.deploykitOperationId })
        if (request.autoAssignCustomDomains !== false) active = id
        if (loseResponse) {
          loseResponse = false
          throw new Error("lost after acceptance")
        }
        return Response.json({
          id,
          projectId: "app",
          readyState: "READY",
          target: "production",
          url: `${id}.example.test`
        })
      }
      if (url.pathname === "/v2/files") {
        const expected = new Headers(init?.headers).get("x-vercel-digest")!
        const digest = createHash("sha1")
        const body = init?.body
        if (body instanceof ReadableStream) {
          const reader = body.getReader()
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) break
              assert.ok(next.value instanceof Uint8Array)
              assert.ok(next.value.byteLength <= 65536)
              digest.update(next.value)
            }
          } finally {
            reader.releaseLock()
          }
        } else {
          assert.ok(body instanceof Uint8Array)
          digest.update(body)
          uploadedBodies.set(expected, body)
        }
        assert.equal(digest.digest("hex"), expected)
        cached.add(expected)
        return new Response(null, { status: 200 })
      }
      if (url.pathname === "/v6/deployments")
        return Response.json({
          deployments: created
            .filter(item => item.operationId === url.searchParams.get("meta-deploykitOperationId"))
            .map(item => ({
              uid: item.id,
              name: "app",
              readyState: "READY",
              meta: { deploykitOperationId: item.operationId }
            })),
          pagination: { next: null }
        })
      if (url.pathname.includes("/promote/")) {
        active = url.pathname.split("/").at(-1)!
        return new Response(null, { status: 200 })
      }
      if (url.pathname.startsWith("/v13/deployments/"))
        return Response.json({
          id: url.pathname.split("/").at(-1),
          url: `${url.pathname.split("/").at(-1)}.example.test`,
          projectId: "app",
          target: "production",
          readyState: "READY"
        })
      return Response.json({ id: "app", name: "app", targets: { production: { id: active } } })
    }
  })
  const vercel = vercelLayer(client).pipe(Layer.provide(NodeFileSystem.layer))
  const standalone = yield* deployDirectory("app", directory).pipe(Effect.provide(vercel))
  assert.equal(standalone.status, "deployed")
  const preview = yield* Effect.map(Provider.DeploymentProvider, Provider.capabilitiesOf).pipe(
    Effect.provide(vercel)
  )
  assert.equal(preview.previewDeployments, true)
  const verified = yield* publishPreparedDirectory(
    client,
    {
      appId: "app",
      directory,
      operationId: "public-example",
      configJson: '{"example":true}'
    },
    async input => {
      const url = new URL(String(input))
      const files = filesByDeployment.get(url.hostname.split(".")[0]!)
      const path = `.vercel/output/static/${url.pathname === "/" ? "index.html" : url.pathname.slice(1)}`
      const file = files?.find(file => file.file === path)
      const body = file && uploadedBodies.get(file.sha)
      return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
    }
  )
  assert.equal(verified.status, "deployed")
  assert.equal(active, standalone.id)
  const bytes = new TextEncoder().encode("hello")
  const manifest = {
    version: 1,
    entries: (
      [
        [".vercel/output/static/index.html", "hello"],
        [".vercel/output/config.json", '{"version":3}']
      ] as const
    ).map(([path, text]) => {
      const content = new TextEncoder().encode(text)
      return {
        path,
        source: `blob:${path}`,
        byteLength: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        fingerprints: [
          {
            recipe: "vercel-sha1-v1",
            context: "",
            value: createHash("sha1").update(content).digest("hex")
          }
        ]
      }
    })
  }
  const request = {
    appId: "app",
    operationId: "op1",
    manifestJson: yield* Manifest.encode(manifest),
    configPath: ".vercel/output/static/generated/config.json",
    configJson: '{"newGame":true}'
  }
  const source = Source.fromPromise(async () => {
    throw new Error("cached source must not be opened")
  })
  const receipt = yield* publishWorker(request, source).pipe(Effect.provide(vercel))
  const deploymentId: string = decodeReceipt(receipt).deployment.id
  const config = filesByDeployment.get(deploymentId)?.find(file => file.file === request.configPath)
  assert.ok(config)
  assert.equal(config.sha, createHash("sha1").update(request.configJson).digest("hex"))
  assert.equal(active, standalone.id)
  let checked = false
  yield* checkAndActivate(
    "app",
    deploymentId,
    Effect.sync(() => {
      checked = true
    })
  ).pipe(Effect.provide(Layer.succeed(Provider.DeploymentControl, makeVercelControl(client))))
  assert.ok(checked)
  assert.equal(active, deploymentId)
  yield* publishWorker(
    { ...request, operationId: "op2", configJson: '{"newSetting":42}' },
    source
  ).pipe(Effect.provide(vercel))
  loseResponse = true
  const failure = yield* Effect.flip(
    publishWorker({ ...request, operationId: "lost" }, source).pipe(Effect.provide(vercel))
  )
  assert.equal(failure._tag, "ProviderError")
  if (failure._tag !== "ProviderError") throw failure
  assert.equal(failure.outcome, "unknown")
  const control = makeVercelControl(client)
  assert.equal(Provider.capabilitiesOf(control).previewDeployments, true)
  const recovered = yield* control.reconcileDeployment!("app", "lost")
  assert.equal(recovered._tag, "Recovered")
  assert.equal(created.filter(item => item.operationId === "lost").length, 1)
  const wireError = yield* Provider.encodeFailure(failure)
  assert.equal((yield* Provider.decodeFailure(wireError))._tag, "ProviderError")

  const reading = yield* Deferred.make<void>()
  let aborted = false
  const cancelBytes = new Uint8Array([42])
  const cancelManifest = {
    version: 1,
    entries: [
      manifest.entries[1]!,
      {
        path: ".vercel/output/static/cancel.bin",
        source: "cancel",
        byteLength: 1,
        sha256: createHash("sha256").update(cancelBytes).digest("hex"),
        fingerprints: [
          {
            recipe: "vercel-sha1-v1",
            context: "",
            value: createHash("sha1").update(cancelBytes).digest("hex")
          }
        ]
      }
    ]
  }
  const beforeCancellation = created.length
  const cancelled = yield* publishWorker(
    { ...request, operationId: "cancel", manifestJson: yield* Manifest.encode(cancelManifest) },
    Source.fromPromise(
      (_reference, signal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("interrupted"))
          })
          Deferred.doneUnsafe(reading, Effect.void)
        })
    )
  ).pipe(Effect.provide(vercel), Effect.forkChild)
  yield* Deferred.await(reading)
  yield* Fiber.interrupt(cancelled)
  assert.ok(aborted)
  assert.equal(created.length, beforeCancellation)

  const largeChunk = new Uint8Array(65536).fill(42)
  const stagingBudget = yield* makeStagingBudget(16 * 1024 * 1024, 16 * 1024 * 1024)
  const largePath = `${directory}/large.bin`
  yield* Stream.fromIterable(Array.from({ length: 144 }, () => largeChunk)).pipe(
    Stream.run(fs.sink(largePath))
  )
  const largeArtifact = yield* Artifact.make([
    yield* Entry.text(".vercel/output/config.json", '{"version":3}'),
    yield* Entry.file(".vercel/output/static/large.bin", largePath)
  ])
  const uploadOptions: DeployRequestOptions = {
    stagingBudget,
    uploadConcurrency: 16,
    uploadOrder: "largest-first"
  }
  yield* Effect.flatMap(Provider.DeploymentProvider, provider =>
    provider.deploy("app", largeArtifact, uploadOptions)
  ).pipe(Effect.provide(vercel))
  yield* fs.remove(largePath)

  const pageCache = new Set<string>()
  const pages = makeCloudflareClient({
    apiToken: "test",
    accountId: "test",
    fetch: async (input, init) => {
      const url = String(input)
      let result: unknown = null
      if (url.endsWith("upload-token")) result = { jwt: "test" }
      else if (url.endsWith("check-missing"))
        result = decodeHashes(String(init?.body)).hashes.filter(
          (hash: string) => !pageCache.has(hash)
        )
      else if (url.endsWith("assets/upload"))
        for (const item of decodeUploads(
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body)
        ))
          pageCache.add(item.key)
      else if (url.endsWith("deployments"))
        result = {
          id: "pages1",
          project_name: "app",
          latest_stage: { name: "deploy", status: "success" }
        }
      return Response.json({ success: true, result })
    }
  })
  const pageLayer = pagesLayer(pages).pipe(Layer.provide(NodeFileSystem.layer))
  const pagesDirectory = yield* fs.makeTempDirectoryScoped()
  yield* fs.writeFileString(`${pagesDirectory}/index.html`, "hello")
  yield* deployDirectory("app", pagesDirectory).pipe(Effect.provide(pageLayer))
  yield* Stream.fromIterable(Array.from({ length: 144 }, () => largeChunk)).pipe(
    Stream.run(fs.sink(largePath))
  )
  const pagesLarge = yield* Artifact.make([yield* Entry.file("large.bin", largePath)])
  yield* Effect.flatMap(Provider.DeploymentProvider, provider =>
    provider.deploy("app", pagesLarge, { stagingBudget })
  ).pipe(Effect.provide(pageLayer))
  yield* fs.remove(largePath)
  const pageManifest = {
    ...manifest,
    entries: [
      {
        ...manifest.entries[0],
        path: "index.html",
        fingerprints: [
          {
            recipe: "cloudflare-blake3-b64ext-v1",
            context: "html",
            value: pagesDigest(bytes, "index.html")
          }
        ]
      }
    ]
  }
  const warm = yield* Manifest.toArtifact(pageManifest, source)
  yield* Effect.flatMap(Provider.DeploymentProvider, provider => provider.deploy("app", warm)).pipe(
    Effect.provide(pageLayer)
  )
  const changed = yield* Artifact.make([yield* Entry.text("media.txt", "changed media")])
  yield* Effect.flatMap(Provider.DeploymentProvider, provider =>
    provider.deploy("app", changed)
  ).pipe(Effect.provide(pageLayer))
  assert.equal(Provider.capabilitiesOf(makeCloudflareControl(pages)).deferredActivation, false)
})

await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(NodeFileSystem.layer)))
const require = createRequire(import.meta.url)
const effect = realpathSync(require.resolve("effect"))
for (const name of [
  "@deploykit/core",
  "@deploykit/vercel",
  "@deploykit/cloudflare",
  "@deploykit/test",
  "@effect/platform-node",
  "@effect/platform-node-shared"
]) {
  assert.equal(realpathSync(createRequire(require.resolve(name)).resolve("effect")), effect)
}
console.log(
  "Packed consumer proof passed: directory, JSON worker, cold/warm, config edit, media edit, lost response, cancellation, large streamed files on both adapters, caller check, activation, shared Effect runtime"
)
