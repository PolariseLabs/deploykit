"use client"

import { useState } from "react"
import { highlight } from "./highlight"

/** Short, real Effect examples. The Promise versions live in the docs. */
const examples: ReadonlyArray<{ label: string; code: string }> = [
  {
    label: "Deploy",
    code: `import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Deploykit } from "@deploykit/core"
import * as Vercel from "@deploykit/vercel"

const publish = Effect.gen(function* () {
  const deploykit = yield* Deploykit.Deploykit
  const artifact = yield* Artifact.fromDirectory("./dist")
  return yield* deploykit.deployAndWait(appId, artifact)
})

const DeploykitLive = Vercel.layerConfig().pipe(Layer.provideMerge(NodeFileSystem.layer))
publish.pipe(Effect.provide(DeploykitLive))`
  },
  {
    label: "Stage, then go live",
    code: `const release = Effect.gen(function* () {
  const deploykit = yield* Deploykit.Deploykit
  const staged = yield* deploykit.deploy(appId, artifact, { activation: "deferred" })

  const ready = yield* deploykit.waitUntilReady(appId, staged.id)
  yield* runYourChecks(ready.url)

  return yield* deploykit.activateDeployment(appId, staged.id)
})`
  },
  {
    label: "Handle failure",
    code: `const publish = deploykit.deploy(appId, artifact, { operationId }).pipe(
  // The host may have created it. Look it up, don't deploy twice.
  Effect.catchTag("ProviderError", error =>
    error.recovery === "reconcile"
      ? deploykit.reconcileDeployment(appId, operationId)
      : Effect.fail(error)
  )
)`
  },
  {
    label: "Test",
    code: `import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as Test from "@deploykit/test"

// In memory. Nothing leaves the process.
const TestLive = Test.deploykitLayer({ failOn: { build: ["app-2"] } }).pipe(
  Layer.provideMerge(NodeFileSystem.layer)
)

it.effect("publishes", () => publish.pipe(Effect.provide(TestLive)))`
  }
]

export function Examples() {
  const [selected, setSelected] = useState(0)
  const example = examples[selected] ?? examples[0]!

  return (
    <div className="examples">
      <div className="tabs" role="tablist">
        {examples.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="tab"
            aria-selected={index === selected}
            onClick={() => setSelected(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <pre>{highlight(example.code)}</pre>
    </div>
  )
}
