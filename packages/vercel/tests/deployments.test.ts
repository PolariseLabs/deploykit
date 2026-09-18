import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { Artifact, Entry } from "@deploykit/core"
import { bytesOf, deployToVercelProject, getDeployment } from "../src/services/deployments.ts"
import { stubClient } from "./stub.ts"
import type { VercelReadyState } from "../src/services/client.ts"

/** sha1 of the empty string, and of "hi", from `printf ... | shasum`. */
const EMPTY_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709"
const HI_SHA = "c22b5f9178342609428d6f51b2c5af4c0bde6a42"

it.layer(NodeFileSystem.layer)("with a filesystem", it => {
  describe("bytesOf", () => {
    it.effect("encodes text as UTF-8, not UTF-16", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const entry = yield* Entry.text("cafe.txt", "café")

        const bytes = yield* bytesOf(fs, entry)

        assert.strictEqual(bytes.byteLength, 5, "4 code units, 5 bytes on the wire")
      })
    )

    it.effect("passes byte entries through untouched", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const entry = yield* Entry.bytes("logo.png", new Uint8Array([1, 2, 3]))

        const bytes = yield* bytesOf(fs, entry)

        assert.deepStrictEqual(Array.from(bytes), [1, 2, 3])
      })
    )

    it.effect("reads file entries off disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/hi.txt`, "hi")
        const entry = yield* Entry.file("hi.txt", `${dir}/hi.txt`)

        const bytes = yield* bytesOf(fs, entry)

        assert.strictEqual(new TextDecoder().decode(bytes), "hi")
      })
    )

    it.effect("surfaces a missing file as a ProviderError, not a raw PlatformError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const entry = yield* Entry.file("gone.txt", "/does/not/exist.txt")
        const artifact = yield* Artifact.make([entry])

        const error = yield* Effect.flip(deployToVercelProject(stub.client, fs, "prj_1", artifact))

        assert.strictEqual(error._tag, "ProviderError")
        assert.strictEqual(error.provider, "vercel")
        assert.strictEqual(error.appId, "prj_1")
      })
    )
  })

  describe("deployToVercelProject", () => {
    it.effect("uploads every entry with its sha1 and byte length", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("hi.txt", "hi"),
          yield* Entry.text("empty.txt", "")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(stub.uploads.length, 2)
        const shas = stub.uploads.map(upload => upload.xVercelDigest).sort()
        assert.deepStrictEqual(shas, [EMPTY_SHA, HI_SHA].sort())
        const sizes = stub.uploads.map(upload => upload.contentLength).sort()
        assert.deepStrictEqual(sizes, [0, 2])
      })
    )

    it.effect("sends the artifact's paths to createDeployment, in insertion order", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("index.html", "<h1>hi</h1>"),
          yield* Entry.text("about.html", "about"),
          yield* Entry.text("style.css", "body{}")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        const body = stub.deployRequests[0] as { files: ReadonlyArray<{ file: string }> }
        assert.deepStrictEqual(
          body.files.map(file => file.file),
          ["index.html", "about.html", "style.css"]
        )
      })
    )

    it.effect("deploys an empty artifact without uploading anything", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()

        const deployment = yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

        assert.strictEqual(stub.uploads.length, 0)
        assert.strictEqual(deployment.id, "dpl_1")
      })
    )

    it.effect("turns an SDK rejection into a ProviderError carrying the app id", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ rejectWith: new Error("rate limited") })

        const error = yield* Effect.flip(
          deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)
        )

        assert.strictEqual(error.message, "rate limited")
        assert.strictEqual(error.appId, "prj_1")
        assert.strictEqual(error.provider, "vercel")
      })
    )

    it.effect("copes with a rejection that is not an Error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ rejectWith: "just a string" })

        const error = yield* Effect.flip(
          deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)
        )

        assert.strictEqual(error.message, "Unknown error")
      })
    )

    it.effect("prefixes the returned URL with https, as Vercel omits the scheme", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({
          deployment: {
            id: "dpl_1",
            readyState: "READY",
            name: "alpha",
            projectId: "prj_1",
            url: "alpha-abc.vercel.app"
          }
        })

        const deployment = yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

        assert.strictEqual(deployment.url, "https://alpha-abc.vercel.app")
      })
    )

    it.effect("falls back to the requested app id when Vercel omits projectId", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ deployment: { id: "dpl_1", readyState: "QUEUED" } })

        const deployment = yield* deployToVercelProject(
          stub.client,
          fs,
          "prj_fallback",
          Artifact.empty
        )

        assert.strictEqual(deployment.appId, "prj_fallback")
        assert.strictEqual(deployment.name, "dpl_1", "the id stands in for a missing name")
      })
    )
  })
})

describe("getDeployment", () => {
  /**
   * The whole point of the adapter: Vercel's seven states collapse onto the
   * four portable ones, so a caller never has to know what BLOCKED means.
   */
  const cases: ReadonlyArray<readonly [VercelReadyState, string]> = [
    ["QUEUED", "pending"],
    ["INITIALIZING", "pending"],
    ["BUILDING", "deploying"],
    ["READY", "deployed"],
    ["ERROR", "failed"],
    ["CANCELED", "failed"],
    ["BLOCKED", "failed"]
  ]

  for (const [readyState, expected] of cases) {
    it.effect(`maps ${readyState} to ${expected}`, () =>
      Effect.gen(function* () {
        const stub = stubClient({ deployment: { id: "dpl_1", readyState } })

        const deployment = yield* getDeployment(stub.client, "dpl_1")

        assert.strictEqual(deployment.status, expected)
      })
    )
  }

  it.effect("reports an unknown app id rather than inventing one", () =>
    Effect.gen(function* () {
      const stub = stubClient({ deployment: { id: "dpl_1", readyState: "QUEUED" } })

      const deployment = yield* getDeployment(stub.client, "dpl_1")

      assert.strictEqual(deployment.appId, "unknown")
    })
  )

  it.effect("turns an SDK rejection into a ProviderError carrying the deployment id", () =>
    Effect.gen(function* () {
      const stub = stubClient({ rejectWith: new Error("not found") })

      const error = yield* Effect.flip(getDeployment(stub.client, "dpl_missing"))

      assert.strictEqual(error.message, "not found")
      assert.strictEqual(error.deploymentId, "dpl_missing")
    })
  )
})
