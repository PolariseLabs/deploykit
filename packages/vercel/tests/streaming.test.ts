import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { Artifact, Manifest } from "@deploykit/core"
import { makeStagingBudget, stageEntry, openStagedBody } from "@deploykit/core/staging"
import { makeVercelClient } from "../src/services/http.ts"
import { deployToVercelProject } from "../src/services/deployments.ts"
import { stubClient } from "./stub.ts"

const chunk = new Uint8Array(65536).fill(42)
const count = 144
const size = chunk.byteLength * count
const hash = (algorithm: string) => {
  const digest = createHash(algorithm)
  for (let i = 0; i < count; i++) digest.update(chunk)
  return digest.digest("hex")
}
const sha1 = hash("sha1")
const manifest = {
  version: 1,
  entries: [
    {
      path: "large.bin",
      source: "blob:large",
      byteLength: size,
      sha256: hash("sha256"),
      fingerprints: [{ recipe: "vercel-sha1-v1", context: "", value: sha1 }]
    }
  ]
}

it.effect("uploads a 9 MiB file in chunks and reopens the staged file for retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    let reads = 0
    const artifact = yield* Manifest.toArtifact(manifest, {
      open: () => {
        reads++
        return Stream.fromIterable(Array.from({ length: count }, () => chunk))
      }
    })
    let uploads = 0
    const bodies = new Set<ReadableStream<unknown>>()
    const client = makeVercelClient({
      token: "test",
      retry: { attempts: 2, baseDelay: 0 },
      fetch: async (_url, init) => {
        assert.strictEqual(new Headers(init?.headers).get("content-length"), String(size))
        const body = init?.body
        assert.instanceOf(body, ReadableStream)
        if (!(body instanceof ReadableStream)) throw new Error("Expected a stream")
        bodies.add(body)
        const reader = body.getReader()
        const digest = createHash("sha1")
        let received = 0
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            if (!(next.value instanceof Uint8Array)) throw new Error("Expected byte chunk")
            assert.isAtMost(next.value.byteLength, 65536)
            received += next.value.byteLength
            digest.update(next.value)
          }
        } finally {
          reader.releaseLock()
        }
        assert.strictEqual(received, size)
        assert.strictEqual(digest.digest("hex"), sha1)
        uploads++
        return uploads === 1 ? new Response("{}", { status: 503 }) : new Response("")
      }
    })
    const stub = stubClient({ missingOnFirstDeploy: [sha1] })
    yield* deployToVercelProject(
      { ...client, createDeployment: stub.client.createDeployment },
      localFs,
      "app",
      artifact
    )
    assert.strictEqual(reads, 1)
    assert.strictEqual(uploads, 2)
    assert.strictEqual(bodies.size, 2)
    assert.strictEqual(stub.deployRequests.length, 2)
    assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect("cancelling an upload aborts fetch and removes the staged file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    const stagingBudget = yield* makeStagingBudget(size, size)
    const artifact = yield* Manifest.toArtifact(manifest, {
      open: () => Stream.fromIterable(Array.from({ length: count }, () => chunk))
    })
    const started = yield* Deferred.make<void>()
    let aborted = false
    const client = makeVercelClient({
      token: "test",
      fetch: async (_url, init) => {
        Deferred.doneUnsafe(started, Effect.void)
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        )
      }
    })
    const stub = stubClient({ missingOnFirstDeploy: [sha1] })
    const fiber = yield* deployToVercelProject(
      { ...client, createDeployment: stub.client.createDeployment },
      localFs,
      "app",
      artifact,
      { stagingBudget }
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.isTrue(aborted)
    assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
    yield* Effect.scoped(stagingBudget.reserve(size))
    assert.strictEqual(stub.deployRequests.length, 1)
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect("rejects unsupported clients and disk limits before creating a deployment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const artifact = yield* Manifest.toArtifact(manifest, {
      open: () => Stream.die("must not open")
    })
    const stub = stubClient()
    assert.strictEqual(
      (yield* Effect.flip(deployToVercelProject(stub.client, fs, "app", artifact)))._tag,
      "UnsupportedError"
    )
    const stagingBudget = yield* makeStagingBudget(1024, 1024)
    assert.strictEqual(
      (yield* Effect.flip(
        deployToVercelProject(stub.client, fs, "app", artifact, { stagingBudget })
      ))._tag,
      "TransferLimitError"
    )
    assert.strictEqual(stub.deployRequests.length, 0)
    assert.strictEqual(Artifact.list(artifact).length, 1)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("sends exact buffered and streamed bytes through native fetch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const staging = yield* makeStagingBudget()
    const artifact = yield* Manifest.toArtifact(manifest, {
      open: () => Stream.fromIterable(Array.from({ length: count }, () => chunk))
    })
    const file = yield* stageEntry(fs, Artifact.list(artifact)[0]!, staging)
    let received = 0
    let digest = ""
    let length: string | undefined
    const server = createServer((request, response) => {
      const hash = createHash("sha1")
      length = request.headers["content-length"]
      request.on("data", (chunk: Uint8Array) => {
        received += chunk.byteLength
        hash.update(chunk)
      })
      request.on("end", () => {
        digest = hash.digest("hex")
        response.end()
      })
    })
    yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, "127.0.0.1", resolve)
          })
      ),
      () => Effect.promise(() => new Promise<void>(resolve => server.close(() => resolve())))
    )
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Expected local TCP port")
    const client = makeVercelClient({
      token: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      retry: { attempts: 1 }
    })
    const bytes = new Uint8Array([0, 128, 255])
    const expected = createHash("sha1").update(bytes).digest("hex")
    yield* client.uploadFile(expected, bytes)
    assert.strictEqual(received, 3)
    assert.strictEqual(length, "3")
    assert.strictEqual(digest, expected)
    received = 0
    yield* client.uploadFileStream!(file.sha1, file.byteLength, openStagedBody(fs, file.path))
    assert.strictEqual(received, size)
    assert.strictEqual(length, String(size))
    assert.strictEqual(digest, sha1)
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)
