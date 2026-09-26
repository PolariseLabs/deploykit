import { Effect, Layer, Schedule } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Deploykit, Platform, Provider } from "@deploykit/core"
import * as Vercel from "@deploykit/vercel"

export const publishEffect = (input: {
  appId: string
  directory: string
  operationId: string
  recordCreated: (deployment: Provider.Deployment) => Effect.Effect<void, Provider.ValidationError>
}) =>
  Effect.gen(function* () {
    const client = yield* Deploykit.Deploykit
    const created = yield* client.deployDirectory(input.appId, input.directory, {
      target: "production",
      activation: "deferred",
      operationId: input.operationId
    })
    yield* input.recordCreated(created)
    const ready = yield* client.getDeployment(input.appId, created.id).pipe(
      Effect.repeat({
        until: deployment => Provider.isTerminal(deployment.status),
        schedule: Schedule.spaced("1 second")
      })
    )
    if (ready.status !== "deployed" || ready.url === undefined) {
      return yield* new Provider.ValidationError({ message: ready.reason ?? "Deployment failed" })
    }
    yield* Platform.waitUntilServing(ready.url)
    return ready
  }).pipe(Effect.timeout("5 minutes"))

export const VercelLive = Vercel.layerConfig().pipe(Layer.provide(NodeFileSystem.layer))
