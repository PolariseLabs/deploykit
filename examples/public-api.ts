import { Config, Effect, Layer, Schedule, Schema } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Deploykit, Entry, Platform, Provider } from "@deploykit/core"
import * as Telemetry from "@deploykit/core/telemetry"
import { layerWith, vercelClientFromConfig } from "@deploykit/vercel"
import type { VercelClient } from "@deploykit/vercel"

class VerificationError extends Schema.TaggedError<VerificationError>()("VerificationError", {
  message: Schema.String
}) {}

export const publishPreparedDirectory = (
  client: VercelClient,
  input: { appId: string; directory: string; operationId: string; configJson: string },
  fetcher: typeof fetch = globalThis.fetch
) =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const prepared = yield* Artifact.fromDirectory(input.directory)
    const artifact = yield* Artifact.add(
      prepared,
      yield* Entry.text(".vercel/output/static/generated/config.json", input.configJson)
    )
    const deployment = yield* deploykit.deploy(input.appId, artifact, {
      target: "production",
      activation: "deferred",
      operationId: input.operationId
    })
    yield* Effect.logInfo("Deployment created", { id: deployment.id, url: deployment.url })

    const ready = yield* deploykit.getDeployment(input.appId, deployment.id).pipe(
      Effect.repeat({
        until: result => Provider.isTerminal(result.status),
        schedule: Schedule.spaced("1 second")
      }),
      Effect.timeout("2 minutes")
    )
    if (ready.status !== "deployed" || ready.url === undefined)
      return yield* new VerificationError({ message: "Deployment is not ready" })
    yield* Platform.waitUntilServing(ready.url, { fetch: fetcher, timeoutMs: 60000 })
    const url = `${ready.url}/generated/config.json`
    yield* Telemetry.observe(
      "consumer",
      "verifyConfig",
      Effect.tryPromise({
        try: async signal => {
          const response = await fetcher(url, { signal, redirect: "manual" })
          try {
            if (!response.ok || (await response.text()) !== input.configJson)
              throw new Error("Config differs")
          } finally {
            await response.body?.cancel().catch(() => undefined)
          }
        },
        catch: () => new VerificationError({ message: "Generated config verification failed" })
      }).pipe(Effect.timeout("30 seconds"))
    )
    return ready
  }).pipe(
    Effect.provide(
      Deploykit.layer().pipe(
        Layer.provide(layerWith(client)),
        Layer.provideMerge(NodeFileSystem.layer)
      )
    )
  )

// This flag opts into deployment; importing the example performs no provider calls.
if (process.argv.includes("--deploy")) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* vercelClientFromConfig
      const result = yield* publishPreparedDirectory(client, {
        appId: yield* Config.string("DEPLOYKIT_TEST_APP_ID"),
        directory: yield* Config.string("DEPLOYKIT_ARTIFACT_DIR"),
        operationId: yield* Config.string("DEPLOYKIT_OPERATION_ID"),
        configJson: '{"featureEnabled":true}'
      }).pipe(Effect.provideService(Telemetry.Observer, event => Effect.logInfo(event)))
      yield* Effect.logInfo("Checked deployment; activation remains caller-controlled", {
        url: result.url
      })
    })
  )
}
