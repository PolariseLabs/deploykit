import { Effect } from "effect"
import { Artifact, Provider } from "@deploykit/core"

export const deployDirectory = (appId: string, directory: string) =>
  Effect.gen(function* () {
    const provider = yield* Provider.DeploymentProvider
    const artifact = yield* Artifact.fromDirectory(directory)
    return yield* provider.deploy(appId, artifact)
  })
