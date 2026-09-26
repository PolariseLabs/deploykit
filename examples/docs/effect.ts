import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Deploykit, Platform, Provider } from "@deploykit/core"
import * as Vercel from "@deploykit/vercel"

export const publishEffect = <E>(input: {
  appId: string
  directory: string
  operationId: string
  recordCreated: (deployment: Provider.Deployment) => Effect.Effect<void, E>
}) =>
  Effect.gen(function* () {
    const client = yield* Deploykit.Deploykit
    const created = yield* client.deployDirectory(input.appId, input.directory, {
      target: "production",
      activation: "deferred",
      operationId: input.operationId
    })
    yield* input.recordCreated(created)
    const ready = yield* client.waitUntilReady(input.appId, created.id)
    if (ready.status !== "deployed" || ready.url === undefined) {
      return yield* new Provider.ValidationError({ message: ready.reason ?? "Deployment failed" })
    }
    yield* Platform.waitUntilServing(ready.url)
    return ready
  }).pipe(Effect.timeout("5 minutes"))

export const VercelLive = Vercel.layerConfig().pipe(Layer.provide(NodeFileSystem.layer))
