import { Effect, Layer, ManagedRuntime, Option, Schedule } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Deploykit, Entry, Platform, Provider, Source } from "@deploykit/core"
import * as ManifestBuilder from "@deploykit/core/manifest-builder"
import * as Telemetry from "@deploykit/core/telemetry"
import * as Vercel from "@deploykit/vercel"
import type { DeployRequestOptions } from "@deploykit/vercel"
import * as Cloudflare from "@deploykit/cloudflare"
import * as Test from "@deploykit/test"
import { createClient } from "@deploykit/node/vercel"
import { AbortError, ProviderError, waitUntilServing, manifestFromDirectory } from "@deploykit/node"

export const DeploykitLive = Vercel.layerConfig().pipe(Layer.provideMerge(NodeFileSystem.layer))
export const CfLive = Cloudflare.layer({ apiToken: "x", accountId: "y", previewBranch: "p" }).pipe(
  Layer.provide(NodeFileSystem.layer)
)
export const Limited = Vercel.layerConfig({ memoryBudgetBytes: 1, stagingBudgetBytes: 2 })

export const publish = Effect.gen(function* () {
  const deploykit = yield* Deploykit.Deploykit
  const app = yield* deploykit.createApp("my-site")
  const deployment = yield* deploykit.deployDirectory(app.id, "./build", {
    onProgress: event => Effect.logInfo("p", event)
  })
  const ready = yield* deploykit.getDeployment(app.id, deployment.id).pipe(
    Effect.repeat({
      until: d => Provider.isTerminal(d.status),
      schedule: Schedule.spaced("1 second")
    }),
    Effect.timeout("5 minutes")
  )
  if (ready.status === "failed" || ready.url === undefined) {
    return yield* new Provider.ValidationError({ message: ready.reason ?? "Build failed" })
  }
  yield* Platform.waitUntilServing(ready.url)
  const existing = yield* deploykit.findAppByName("x")
  if (Option.isSome(existing)) console.log(existing.value.id)
  yield* deploykit.activateDeployment(app.id, deployment.id)
  const act = yield* deploykit.getActivation(app.id, deployment.id).pipe(
    Effect.repeat({
      until: a => a.state === "active",
      schedule: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "1 minute" }))
    })
  )
  const r = yield* deploykit.reconcileDeployment(app.id, "op")
  yield* deploykit.setAccess(app.id, { _tag: "Password", password: "p" })
  const options: DeployRequestOptions = { uploadConcurrency: 16, uploadOrder: "largest-first" }
  const artifact = yield* Artifact.make([yield* Entry.text("a.txt", "a")])
  yield* deploykit.deploy(app.id, artifact, options)
  const read = async (reference: string, signal: AbortSignal) => {
    const response = await fetch(reference, { signal })
    return response.body!
  }
  yield* deploykit.deployManifest(app.id, {}, Source.fromReadableStream(read))
  const m = yield* ManifestBuilder.fromDirectory("./build", { source: p => p })
  const caps = deploykit.capabilities
  const checked = Telemetry.observe("my-app", "check", Effect.void)
  return [act, r, m, caps, checked]
}).pipe(
  Effect.catchTag("ProviderError", e => (e.recovery === "retry" ? Effect.void : Effect.fail(e)))
)

export const run = () => Effect.runPromise(publish.pipe(Effect.provide(DeploykitLive)))

export const PlatformLive = Platform.layer.pipe(
  Layer.provide(Vercel.vercelLayer),
  Layer.provide(Test.MemoryAppStore.layer()),
  Layer.provide(NodeFileSystem.layer)
)
export const testLayer = (config?: Test.TestProviderConfig) =>
  Deploykit.layer().pipe(
    Layer.provideMerge(Test.layer(config)),
    Layer.provideMerge(NodeFileSystem.layer)
  )
export const platformTestLayer = Platform.layer.pipe(
  Layer.provideMerge(Test.layer()),
  Layer.provideMerge(Test.MemoryAppStore.layer())
)
export const rt = ManagedRuntime.make(DeploykitLive)
export const fromTest = Effect.gen(function* () {
  const test = yield* Test.TestProvider
  return yield* test.artifactFor("x")
}).pipe(Effect.provide(testLayer({ lostCreateResponse: ["app-1"] })))
export const encoded = (e: Provider.Failure) => Provider.encodeFailure(e)

export async function promise() {
  await using deploykit = createClient({
    token: "t",
    uploadThrottle: "balanced",
    memoryBudgetBytes: 1
  })
  const d = await deploykit.deployDirectory("a", "./b", {
    uploadConcurrency: 16,
    signal: new AbortController().signal
  })
  await waitUntilServing(d.url!, { timeoutMs: 60_000 })
  const m = await manifestFromDirectory("./build", { source: p => p })
  await deploykit.deployManifest(
    "a",
    m,
    async (_r, signal) => (await fetch("x", { signal })).body!,
    { operationId: "x" }
  )
  const found = await deploykit.findAppByName("n")
  try {
    await deploykit.getCapabilities()
  } catch (e) {
    if (!(e instanceof ProviderError || e instanceof AbortError)) throw e
  }
  return found
}
