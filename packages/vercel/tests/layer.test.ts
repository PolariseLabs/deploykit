import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Artifact, Deploykit, Entry } from "@deploykit/core"
import { layerWith } from "../src/index.ts"
import type { DeployRequestOptions } from "../src/index.ts"
import { stubClient } from "./stub.ts"

const kit = (defaults: Parameters<typeof layerWith>[1]) =>
  Deploykit.layer().pipe(
    Layer.provide(layerWith(stubClient().client, defaults)),
    Layer.provide(NodeFileSystem.layer)
  )

it.effect("layer upload defaults reach every deploy, and a deploy's own options win", () =>
  Effect.gen(function* () {
    const artifact = yield* Artifact.make([yield* Entry.text("index.html", "x")])
    const rejected = yield* Deploykit.Deploykit.pipe(
      Effect.flatMap(deploykit => Effect.flip(deploykit.deploy("app", artifact))),
      Effect.provide(kit({ uploadConcurrency: 0 }))
    )
    assert.strictEqual(rejected._tag, "ValidationError")

    // A typed variable, not a literal: per-deploy Vercel options are not in the portable type.
    const options: DeployRequestOptions = { uploadConcurrency: 4 }
    const overridden = yield* Deploykit.Deploykit.pipe(
      Effect.flatMap(deploykit => deploykit.deploy("app", artifact, options)),
      Effect.provide(kit({ uploadConcurrency: 0 }))
    )
    assert.isDefined(overridden.id)
  })
)
