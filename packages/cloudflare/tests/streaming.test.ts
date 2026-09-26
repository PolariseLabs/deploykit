import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Schema, Stream } from "effect"
import { Artifact, Entry, Manifest } from "@deploykit/core"
import { makeStagingBudget } from "@deploykit/core/staging"
import { pagesDigest } from "../src/services/digest.ts"
import { encodeBase64, streamedDigest } from "../src/services/streaming.ts"
import { makeCloudflareClient } from "../src/services/http.ts"
import { deployToPagesProject } from "../src/services/deployments.ts"
import { stubClient } from "./stub.ts"

const decodeUpload = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.String,
      base64: Schema.Literal(true),
      metadata: Schema.Struct({ contentType: Schema.String })
    })
  )
)
const success = () => Response.json({ success: true, result: null })
const fixture = (size: number) => {
  const bytes = Buffer.alloc(size, 42)
  const hash = pagesDigest(bytes, "large.bin")
  const manifest = {
    version: 1,
    entries: [
      {
        path: "large.bin",
        byteLength: size,
        source: "blob:large",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        fingerprints: [{ recipe: "cloudflare-blake3-b64ext-v1", context: "bin", value: hash }]
      }
    ]
  }
  const open = () =>
    Stream.fromIterable(
      (function* () {
        for (let offset = 0; offset < size; offset += 65536)
          yield bytes.subarray(offset, offset + 65536)
      })()
    )
  return { bytes, hash, manifest, open }
}

it.effect("base64 and fingerprints are independent of chunk boundaries and repeated reads", () =>
  Effect.gen(function* () {
    for (const size of [0, 1, 2, 3, 4, 5, 127]) {
      const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i))
      for (const width of [1, 2, 3, 7, 64]) {
        const source = Stream.fromIterable(
          Array.from({ length: Math.ceil(size / width) }, (_, i) =>
            bytes.subarray(i * width, (i + 1) * width)
          )
        )
        const encoded = encodeBase64(source).pipe(
          Stream.runFold(
            () => "",
            (all, part) => all + part
          )
        )
        assert.strictEqual(yield* encoded, bytes.toString("base64"))
        assert.strictEqual(yield* encoded, bytes.toString("base64"))
        assert.strictEqual(
          yield* streamedDigest(source, "file.bin"),
          pagesDigest(bytes, "file.bin")
        )
      }
    }
  })
)

it.effect("retries a streamed 9 MiB asset from one verified staged source", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    const input = fixture(9 * 1024 * 1024 + 1)
    let reads = 0
    let attempts = 0
    const bodies = new Set<ReadableStream<unknown>>()
    const artifact = yield* Manifest.toArtifact(input.manifest, {
      open: () => {
        reads++
        return input.open()
      }
    })
    const client = makeCloudflareClient({
      apiToken: "test",
      accountId: "test",
      retry: { attempts: 2, baseDelay: 0 },
      fetch: async (_url, init) => {
        if (!(init?.body instanceof ReadableStream)) throw new Error("Expected stream")
        bodies.add(init.body)
        const text = await new Response(init.body).text()
        assert.strictEqual(
          Buffer.byteLength(text),
          Number(new Headers(init.headers).get("content-length"))
        )
        const parsed: unknown = JSON.parse(text)
        const [upload] = decodeUpload(parsed)
        assert.strictEqual(upload?.key, input.hash)
        assert.deepStrictEqual(Buffer.from(upload!.value, "base64"), input.bytes)
        attempts++
        return attempts === 1
          ? Response.json({ success: false, errors: [], result: null }, { status: 503 })
          : success()
      }
    })
    const stub = stubClient()
    yield* deployToPagesProject(
      { ...stub.client, uploadAssetStream: client.uploadAssetStream! },
      localFs,
      "app",
      artifact
    )
    assert.strictEqual(reads, 1)
    assert.strictEqual(attempts, 2)
    assert.strictEqual(bodies.size, 2)
    assert.strictEqual(stub.manifests.length, 1)
    assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect(
  "supports exactly 25 MiB through native HTTP and rejects larger assets before calls",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const input = fixture(25 * 1024 * 1024)
      const artifact = yield* Manifest.toArtifact(input.manifest, { open: input.open })
      let received = ""
      let length: string | undefined
      const server = createServer((request, response) => {
        length = request.headers["content-length"]
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => {
          received += chunk
        })
        request.on("end", () => {
          response.end(JSON.stringify({ success: true, result: null }))
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
      if (address === null || typeof address === "string") throw new Error("Expected local port")
      const client = makeCloudflareClient({
        apiToken: "test",
        accountId: "test",
        baseUrl: `http://127.0.0.1:${address.port}`,
        retry: { attempts: 1 }
      })
      const stub = stubClient()
      yield* deployToPagesProject(
        { ...stub.client, uploadAssetStream: client.uploadAssetStream! },
        fs,
        "app",
        artifact
      )
      assert.strictEqual(String(Buffer.byteLength(received)), length)
      const parsed: unknown = JSON.parse(received)
      const [upload] = decodeUpload(parsed)
      assert.strictEqual(upload?.key, input.hash)
      assert.deepStrictEqual(Buffer.from(upload!.value, "base64"), input.bytes)
      const oversized = yield* Artifact.make([
        yield* Entry.deferred("too-big.bin", {
          byteLength: input.bytes.length + 1,
          read: async () => {
            throw new Error("must not read")
          }
        })
      ])
      const untouched = stubClient()
      const error = yield* Effect.flip(
        deployToPagesProject(
          { ...untouched.client, uploadAssetStream: client.uploadAssetStream! },
          fs,
          "app",
          oversized
        )
      )
      assert.strictEqual(error._tag, "TransferLimitError")
      assert.deepStrictEqual(untouched.calls, [])
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect("cancellation aborts upload, deletes staging and releases disk reservations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    const input = fixture(9 * 1024 * 1024)
    const artifact = yield* Manifest.toArtifact(input.manifest, { open: input.open })
    const stagingBudget = yield* makeStagingBudget(input.bytes.length, input.bytes.length)
    const started = yield* Deferred.make<void>()
    let aborted = false
    const client = makeCloudflareClient({
      apiToken: "test",
      accountId: "test",
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
    const stub = stubClient()
    const fiber = yield* deployToPagesProject(
      { ...stub.client, uploadAssetStream: client.uploadAssetStream! },
      localFs,
      "app",
      artifact,
      { stagingBudget }
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.isTrue(aborted)
    assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
    assert.strictEqual(stub.manifests.length, 0)
    yield* Effect.scoped(stagingBudget.reserve(input.bytes.length))
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect(
  "rejects worker bundles, unsupported clients and changed fingerprints before upload",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const input = fixture(9 * 1024 * 1024)
      const artifact = yield* Manifest.toArtifact(input.manifest, { open: input.open })
      const unsupported = stubClient()
      assert.strictEqual(
        (yield* Effect.flip(deployToPagesProject(unsupported.client, fs, "app", artifact)))._tag,
        "UnsupportedError"
      )
      assert.deepStrictEqual(unsupported.calls, [])
      const worker = yield* Artifact.make([
        yield* Entry.deferred("_worker.js", {
          byteLength: input.bytes.length,
          read: async () => {
            throw new Error("must not read")
          }
        })
      ])
      assert.strictEqual(
        (yield* Effect.flip(deployToPagesProject(unsupported.client, fs, "app", worker)))._tag,
        "TransferLimitError"
      )
      const wrong = yield* Manifest.toArtifact(
        {
          ...input.manifest,
          entries: [
            {
              ...input.manifest.entries[0]!,
              fingerprints: [
                { recipe: "cloudflare-blake3-b64ext-v1", context: "bin", value: "0".repeat(32) }
              ]
            }
          ]
        },
        { open: input.open }
      )
      let uploaded = false
      const client = {
        ...unsupported.client,
        uploadAssetStream: () =>
          Effect.sync(() => {
            uploaded = true
          })
      }
      assert.strictEqual(
        (yield* Effect.flip(deployToPagesProject(client, fs, "app", wrong)))._tag,
        "IntegrityError"
      )
      assert.isFalse(uploaded)
      assert.strictEqual(unsupported.manifests.length, 0)
    }).pipe(Effect.provide(NodeFileSystem.layer))
)
