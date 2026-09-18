import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import * as Artifact from "@deploykit/core/artifact"
import * as Entry from "@deploykit/core/entry"
import { deployToPagesProject } from "../src/services/deployments.ts"
import { WORKER_PATH, workerBundle } from "../src/services/worker.ts"
import { stubClient } from "./stub.ts"

const WORKER = "export default { fetch: () => new Response('hi') }"

/** Read the serialised upload form back, which is what Pages will parse. */
const partsOf = async (bundle: Blob) => {
  const form = await new Response(bundle, {
    headers: { "content-type": bundle.type }
  }).formData()
  return form
}

describe("the worker bundle", () => {
  it.effect("is a Workers upload form naming its entry module", () =>
    Effect.gen(function* () {
      const bundle = yield* Effect.promise(() =>
        workerBundle({ main: { name: "index.js", content: WORKER } })
      )
      const form = yield* Effect.promise(() => partsOf(bundle))

      const metadata = JSON.parse(String(form.get("metadata")))
      assert.strictEqual(metadata.main_module, "index.js")
      assert.isString(metadata.compatibility_date, "pinned, or behaviour shifts under you")
      assert.isDefined(form.get("index.js"), "the module travels as its own part")
    })
  )

  it.effect("carries extra modules the entry imports", () =>
    Effect.gen(function* () {
      const bundle = yield* Effect.promise(() =>
        workerBundle({
          main: { name: "index.js", content: WORKER },
          modules: [{ name: "helper.js", content: "export const x = 1" }]
        })
      )
      const form = yield* Effect.promise(() => partsOf(bundle))

      assert.isDefined(form.get("index.js"))
      assert.isDefined(form.get("helper.js"))
    })
  )
})

describe("a worker in the artifact", () => {
  const withFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    effect.pipe(Effect.provide(NodeFileSystem.layer))

  /**
   * The mistake this prevents, confirmed against a real account: uploading
   * _worker.js through the asset manifest deploys successfully and does
   * nothing. The route falls through to index.html and there is no error
   * anywhere. Pages wants it as a separate field.
   */
  it.effect("is lifted out of the manifest, not uploaded as a file", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("index.html", "<html></html>"),
          yield* Entry.text(WORKER_PATH, WORKER)
        ])

        yield* deployToPagesProject(stub.client, fs, "alpha", artifact)

        const manifest = stub.manifests[0]!
        assert.deepStrictEqual(Object.keys(manifest), ["/index.html"])
        assert.isFalse(`/${WORKER_PATH}` in manifest, "not an asset")
        assert.strictEqual(stub.uploads.length, 1, "only the real asset uploads")
      })
    )
  )

  it.effect("sends no bundle when the artifact has no worker", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([yield* Entry.text("index.html", "<html></html>")])

        yield* deployToPagesProject(stub.client, fs, "alpha", artifact)

        assert.isUndefined(stub.extras[0]?.workerBundle)
      })
    )
  )

  it.effect("sends the bundle when it does", () =>
    withFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("index.html", "<html></html>"),
          yield* Entry.text(WORKER_PATH, WORKER)
        ])

        yield* deployToPagesProject(stub.client, fs, "alpha", artifact)

        const bundle = stub.extras[0]?.workerBundle
        assert.isDefined(bundle)
        const form = yield* Effect.promise(() => partsOf(bundle!))
        assert.strictEqual(JSON.parse(String(form.get("metadata"))).main_module, "index.js")
      })
    )
  )
})
