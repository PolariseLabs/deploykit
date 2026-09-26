import { createHash } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { Manifest, Source } from "@deploykit/core"
import { pagesDigest } from "../src/services/digest.ts"
import { deployToPagesProject } from "../src/services/deployments.ts"
import { stubClient } from "./stub.ts"

it.effect("fingerprint context prevents reuse after an extension change", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bytes = new TextEncoder().encode("hello")
    const manifest = {
      version: 1,
      entries: [
        {
          path: "index.html",
          source: "blob:1",
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          fingerprints: [
            {
              recipe: "cloudflare-blake3-b64ext-v1",
              context: "txt",
              value: pagesDigest(bytes, "index.txt")
            }
          ]
        }
      ]
    }
    let reads = 0
    const source = Source.fromPromise(async () => {
      reads++
      return bytes
    })
    const artifact = yield* Manifest.toArtifact(
      yield* Manifest.fromJson(yield* Manifest.encode(manifest)),
      source
    )
    const stub = stubClient()
    yield* deployToPagesProject(stub.client, fs, "app", artifact)
    assert.strictEqual(reads, 2)
    assert.strictEqual(stub.uploads[0]!.key, pagesDigest(bytes, "index.html"))
    const warm = yield* Manifest.toArtifact(
      {
        ...manifest,
        entries: [
          {
            ...manifest.entries[0],
            fingerprints: [
              {
                recipe: "cloudflare-blake3-b64ext-v1",
                context: "html",
                value: pagesDigest(bytes, "index.html")
              }
            ]
          }
        ]
      },
      Source.fromPromise(async () => {
        throw new Error("must not read")
      })
    )
    yield* deployToPagesProject(stubClient({ missing: [] }).client, fs, "app", warm)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
it.effect("unsupported deferred activation fails before any provider calls", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const stub = stubClient()
    const artifact = yield* Manifest.toArtifact(
      { version: 1, entries: [] },
      Source.fromPromise(async () => new Uint8Array())
    )
    assert.strictEqual(
      (yield* Effect.flip(
        deployToPagesProject(stub.client, fs, "app", artifact, { activation: "deferred" })
      ))._tag,
      "UnsupportedError"
    )
    assert.strictEqual(stub.calls.length, 0)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("preview branch validation precedes uploads and cannot select production", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const artifact = yield* Manifest.toArtifact(
      { version: 1, entries: [] },
      Source.fromPromise(async () => new Uint8Array())
    )
    for (const branch of ["main", "staging"]) {
      const stub = stubClient({ project: { id: "app", name: "app", production_branch: "main" } })
      const client = { ...stub.client, previewBranch: branch }
      const result = yield* deployToPagesProject(client, fs, "app", artifact, {
        target: "preview"
      }).pipe(Effect.result)
      if (branch === "main") {
        assert.strictEqual(result._tag, "Failure")
        assert.deepStrictEqual(stub.calls, ["getProject"])
      } else {
        assert.strictEqual(result._tag, "Success")
        assert.strictEqual(stub.extras[0]?.branch, "staging")
      }
    }
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
