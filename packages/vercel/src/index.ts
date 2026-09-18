import { Effect, Layer, Config, Redacted } from "effect"
import { Provider } from "@deploykit/core"
import { createVercelProject, deleteVercelProject, getVercelProject } from "./services/app.js"
import { deployToVercelProject, getDeployment } from "./services/deployments.js"
import { FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Vercel } from "@vercel/sdk"
export const vercelLayer = Layer.effect(
  Provider.DeploymentProvider,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const token = yield* Config.redacted("VERCEL_TOKEN")

    const vercel = new Vercel({
      bearerToken: Redacted.value(token)
    })

    return {
      name: "Vercel",
      createApp: name => createVercelProject(vercel, name),
      getApp: id => getVercelProject(vercel, id),
      deleteApp: id => deleteVercelProject(vercel, id),
      deploy: (appId, artifact) => deployToVercelProject(vercel, fs, appId, artifact),
      getDeployment: id => getDeployment(vercel, id)
    } satisfies Provider.Provider
  })
).pipe(Layer.provide(NodeFileSystem.layer))

export type { VercelClient, VercelDeploymentLike, VercelProjectLike } from "./services/client.js"
