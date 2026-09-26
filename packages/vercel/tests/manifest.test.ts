import { createHash } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Stream } from "effect"
import { Manifest, Source } from "@deploykit/core"
import { deployToVercelProject } from "../src/services/deployments.ts"
import { stubClient } from "./stub.ts"

const bytes = new TextEncoder().encode("hello")
const sha1 = createHash("sha1").update(bytes).digest("hex")
const manifest = {
  version: 1,
  entries: [
    {
      path: "index.html",
      source: "blob:1",
      byteLength: 5,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      fingerprints: [{ recipe: "vercel-sha1-v1", context: "", value: sha1 }]
    }
  ]
}
it.effect("crosses a JSON boundary, then reads only missing bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const wire = yield* Manifest.encode(manifest)
    let reads = 0
    const artifact = yield* Manifest.toArtifact(yield* Manifest.fromJson(wire), {
      open: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            reads++
            return bytes
          })
        )
    })
    const cold = stubClient({ missingOnFirstDeploy: [sha1] })
    yield* deployToVercelProject(cold.client, fs, "app", artifact)
    assert.strictEqual(reads, 1)
    const warm = yield* Manifest.toArtifact(
      manifest,
      Source.fromPromise(async () => {
        throw new Error("must not read")
      })
    )
    yield* deployToVercelProject(stubClient().client, fs, "app", warm)
    assert.strictEqual(cold.uploads.length, 1)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
it.effect("rejects changed sources before uploading and preserves read failures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const [source, tag] of [
      [Source.fromPromise(async () => new TextEncoder().encode("other")), "IntegrityError"],
      [
        Source.fromPromise(async () => {
          throw new Error("private token")
        }),
        "SourceError"
      ]
    ] as const) {
      const stub = stubClient({ missingOnFirstDeploy: [sha1] })
      const artifact = yield* Manifest.toArtifact(manifest, source)
      const error = yield* Effect.flip(deployToVercelProject(stub.client, fs, "app", artifact))
      assert.strictEqual(error._tag, tag)
      assert.strictEqual(stub.uploads.length, 0)
    }
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
