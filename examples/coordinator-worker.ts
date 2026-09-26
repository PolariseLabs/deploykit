import { Effect, Schema } from "effect"
import { Artifact, Entry, Manifest, Provider } from "@deploykit/core"
import type { FileSource } from "@deploykit/core/source"

export interface PublishRequest {
  readonly appId: string
  readonly operationId: string
  readonly manifestJson: string
  readonly configPath: string
  readonly configJson: string
}

// The coordinator persists this request; a transfer worker attaches authorized readers.
export const publishWorker = (request: PublishRequest, source: FileSource) =>
  Effect.gen(function* () {
    const provider = yield* Provider.DeploymentProvider
    const manifest = yield* Manifest.fromJson(request.manifestJson)
    const stored = yield* Manifest.toArtifact(manifest, source)
    const artifact = yield* Artifact.add(
      stored,
      yield* Entry.text(request.configPath, request.configJson)
    )
    const deployment = yield* provider.deploy(request.appId, artifact, {
      operationId: request.operationId,
      target: "production",
      activation: "deferred"
    })
    return yield* Effect.succeed(JSON.stringify({ version: 1, deployment }))
  })

// Caller checks and checkpoint storage remain outside deploykit.
class CheckError extends Schema.TaggedError<CheckError>()("CheckError", {
  message: Schema.String
}) {}

export const checkAndActivate = <E, R>(
  appId: string,
  deploymentId: string,
  check: Effect.Effect<void, E, R>
) =>
  Effect.gen(function* () {
    const control = yield* Provider.DeploymentControl
    if (control.activateDeployment === undefined)
      return yield* new Provider.UnsupportedError({
        provider: control.name,
        capability: "activation",
        message: "Activation is unavailable"
      })
    const deployment = yield* control.getDeployment(appId, deploymentId)
    if (deployment.status !== "deployed")
      return yield* new CheckError({ message: "Deployment is not ready" })
    yield* check
    return yield* control.activateDeployment(appId, deploymentId)
  })
