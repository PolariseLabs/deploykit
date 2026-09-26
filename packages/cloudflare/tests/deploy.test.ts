import * as Telemetry from "@deploykit/core/telemetry"
import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import * as Artifact from "@deploykit/core/artifact"
import * as Entry from "@deploykit/core/entry"
import { deployToPagesProject } from "../src/services/deployments.ts"
import { CLOUDFLARE_DIGEST, extensionOf, pagesDigest } from "../src/services/digest.ts"
import { stubClient } from "./stub.ts"

const withFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(NodeFileSystem.layer))

describe("the Pages digest", () => {
  it("depends on the extension, not just the content", () => {
    const bytes = new TextEncoder().encode("hi")
    assert.notStrictEqual(pagesDigest(bytes, "a.txt"), pagesDigest(bytes, "a.html"))
  })

  it("is the same for the same bytes and extension at different paths", () => {
    const bytes = new TextEncoder().encode("hi")
    assert.strictEqual(pagesDigest(bytes, "one/a.txt"), pagesDigest(bytes, "two/b.txt"))
  })

  it("is 32 hex characters, as wrangler truncates it", () => {
    const hash = pagesDigest(new TextEncoder().encode("hi"), "a.txt")
    assert.strictEqual(hash.length, 32)
    assert.match(hash, /^[0-9a-f]{32}$/)
  })

  it("reads an extension the way wrangler does", () => {
    assert.strictEqual(extensionOf("a/b.txt"), "txt")
    assert.strictEqual(extensionOf("a/b.tar.gz"), "gz")
    assert.strictEqual(extensionOf("a/noext"), "")
    assert.strictEqual(extensionOf("a/.hidden"), "", "a dotfile has no extension")
  })
})

describe("deploying", () => {
  const artifact = Effect.gen(function* () {
    return yield* Artifact.make([
      yield* Entry.text("index.html", "<h1>hi</h1>"),
      yield* Entry.text("style.css", "body{}")
    ])
  })

  it.effect("asks what is missing before uploading anything", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ missing: [] })

        yield* deployToPagesProject(stub.client, fs, "alpha", yield* artifact)

        assert.strictEqual(stub.uploads.length, 0, "Cloudflare already had them")
        assert.strictEqual(stub.checked.length, 1)
        assert.strictEqual(stub.checked[0]?.length, 2, "both hashes offered")
      })
    )
  )

  it.effect("uploads only the hashes Cloudflare reports missing", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const wanted = pagesDigest(new TextEncoder().encode("body{}"), "style.css")
        const stub = stubClient({ missing: [wanted] })

        yield* deployToPagesProject(stub.client, fs, "alpha", yield* artifact)

        assert.strictEqual(stub.uploads.length, 1)
        assert.strictEqual(stub.uploads[0]?.key, wanted)
        assert.strictEqual(stub.uploads[0]?.metadata.contentType, "text/css")
        assert.strictEqual(stub.uploads[0]?.base64, true)
      })
    )
  )

  it.effect("sends a manifest of leading-slash paths to hashes", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ missing: [] })

        yield* deployToPagesProject(stub.client, fs, "alpha", yield* artifact)

        const manifest = stub.manifests[0]!
        assert.deepStrictEqual(Object.keys(manifest).sort(), ["/index.html", "/style.css"])
        assert.strictEqual(
          manifest["/style.css"],
          pagesDigest(new TextEncoder().encode("body{}"), "style.css")
        )
      })
    )
  )

  it.effect("uploads shared bytes once but lists both paths", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const same = yield* Artifact.make([
          yield* Entry.text("a/logo.png", "PNGDATA"),
          yield* Entry.text("b/logo.png", "PNGDATA")
        ])
        const stub = stubClient()

        yield* deployToPagesProject(stub.client, fs, "alpha", same)

        assert.strictEqual(stub.uploads.length, 1, "one hash, one upload")
        assert.strictEqual(Object.keys(stub.manifests[0]!).length, 2, "two paths")
      })
    )
  )

  it.effect("never reads a deferred entry that already carries this digest", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        let reads = 0
        const tree = yield* Artifact.make([
          yield* Entry.deferred("video.mp4", {
            byteLength: 999,
            digests: { [CLOUDFLARE_DIGEST]: "aaaabbbbccccddddeeeeffff00001111" },
            read: () => {
              reads += 1
              return Promise.resolve(new Uint8Array(0))
            }
          })
        ])
        const stub = stubClient({ missing: [] })

        yield* deployToPagesProject(stub.client, fs, "alpha", tree)

        assert.strictEqual(reads, 0, "no fetch, no hash")
        assert.strictEqual(stub.manifests[0]?.["/video.mp4"], "aaaabbbbccccddddeeeeffff00001111")
      })
    )
  )

  it.effect("ignores a digest computed for another provider", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        let reads = 0
        const tree = yield* Artifact.make([
          yield* Entry.deferred("a.txt", {
            byteLength: 2,
            digests: { sha1: "a-vercel-digest" },
            read: () => {
              reads += 1
              return Promise.resolve(new TextEncoder().encode("hi"))
            }
          })
        ])
        const stub = stubClient({ missing: [] })

        yield* deployToPagesProject(stub.client, fs, "alpha", tree)

        assert.strictEqual(reads, 1, "read, because no blake3 digest was offered")
        assert.strictEqual(
          stub.manifests[0]?.["/a.txt"],
          pagesDigest(new TextEncoder().encode("hi"), "a.txt")
        )
      })
    )
  )

  /** Warming the hash cache is an optimisation for next time, not this deploy. */
  it.effect("still deploys when upsert-hashes fails", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ failUpsert: true })

        const deployment = yield* deployToPagesProject(stub.client, fs, "alpha", yield* artifact)

        assert.strictEqual(deployment.status, "deployed")
      })
    )
  )

  it.effect("maps a failure to a ProviderError naming cloudflare", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ failWithStatus: 403, failWithBody: "no permission" })

        const error = yield* Effect.flip(
          deployToPagesProject(stub.client, fs, "alpha", yield* artifact)
        )

        assert.strictEqual(error._tag, "ProviderError")
        if (error._tag !== "ProviderError") throw error
        assert.strictEqual(error.provider, "cloudflare")
        assert.strictEqual(error.statusCode, 403)
        assert.strictEqual(error.appId, "alpha")
      })
    )
  )
})

it.effect("telemetry reports cache decisions and incremental acknowledged uploads", () =>
  withFs(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()
      const events: Array<Telemetry.Event> = []
      const artifact = yield* Artifact.make([
        yield* Entry.text("a.txt", "hi"),
        yield* Entry.text("b.txt", "bye")
      ])
      yield* deployToPagesProject(stub.client, fs, "alpha", artifact).pipe(
        Effect.provideService(Telemetry.Observer, event =>
          Effect.sync(() => {
            events.push(event)
          })
        )
      )
      assert(
        events.some(
          event => event.kind === "progress" && event.stage === "uploading" && event.done === 1
        )
      )
      const last = events
        .filter(event => event.kind === "progress" && event.stage === "uploading")
        .at(-1)
      assert(last?.kind === "progress")
      assert.equal(last.bytes, 5)
      const cache = events.find(event => event.kind === "cache")
      assert(cache?.kind === "cache")
      assert.equal(cache.missingContents, 2)
      assert.equal(cache.missingBytes, 5)
    })
  )
)
