import { Config, Effect, FileSystem, Layer, Redacted } from "effect"
import { Provider } from "@deploykit/core"
import {
  createVercelProject,
  deleteVercelProject,
  findVercelProjectByName,
  getVercelProject,
  setVercelProjectAccess
} from "./services/app.js"
import { deployToVercelProject } from "./services/deployments.js"
import { getDeployment } from "./services/status.js"
import { makeVercelClient } from "./services/http.js"
import type { VercelClient } from "./services/client.js"

/**
 * The Vercel adapter, configured from the environment.
 *
 * Two deliberate choices about what this layer does NOT do.
 *
 * It provides no platform layer. An adapter should not pick the caller's
 * runtime, so `FileSystem` stays in this layer's requirements and the caller
 * supplies `NodeFileSystem.layer` on Node, or any implementation elsewhere.
 * Only `File` entries ever reach it.
 *
 * It reads config rather than taking it, which suits an application. A caller
 * that already holds a token, or wants a different base URL or fetch, builds
 * the client with `makeVercelClient` and uses `layerWith`.
 */
export const vercelLayer = Layer.effect(
  Provider.DeploymentProvider,
  Effect.gen(function* () {
    // VERCEL_TOKEN is Vercel's own convention, so it wins; VERCEL_API_KEY is
    // accepted because plenty of setups already use that name.
    const token = yield* Config.redacted("VERCEL_TOKEN").pipe(
      Config.orElse(() => Config.redacted("VERCEL_API_KEY"))
    )
    const teamId = yield* Config.option(Config.string("VERCEL_TEAM_ID"))

    return makeProvider(
      makeVercelClient({
        token: Redacted.value(token),
        ...(teamId._tag === "Some" ? { teamId: teamId.value } : {})
      }),
      yield* FileSystem.FileSystem
    )
  })
)

/** The same adapter over a client the caller built. The escape hatch, and how tests wire it. */
export const layerWith = (client: VercelClient) =>
  Layer.effect(
    Provider.DeploymentProvider,
    Effect.map(FileSystem.FileSystem, fs => makeProvider(client, fs))
  )

const makeProvider = (vercel: VercelClient, fs: FileSystem.FileSystem): Provider.Provider => ({
  name: "Vercel",
  createApp: name => createVercelProject(vercel, name),
  getApp: id => getVercelProject(vercel, id),
  deleteApp: id => deleteVercelProject(vercel, id),
  findAppByName: name => findVercelProjectByName(vercel, name),
  setAccess: (id, access) => setVercelProjectAccess(vercel, id, access),
  accessModes: new Set<Provider.AccessMode>(["public", "password", "sso"]),
  deploy: (appId, artifact, options) => deployToVercelProject(vercel, fs, appId, artifact, options),
  getDeployment: (appId, id) => getDeployment(vercel, appId, id)
})

export { makeVercelClient } from "./services/http.js"
export type { VercelHttpConfig } from "./services/http.js"
export { VercelApiError } from "./services/client.js"
export type {
  CreateDeploymentRequest,
  VercelClient,
  VercelDeploymentLike,
  VercelFileRef,
  VercelProjectLike,
  VercelReadyState
} from "./services/client.js"
export type { DeployRequestOptions } from "./services/deployments.js"

export {
  controlLayerWith,
  makeVercelControl,
  vercelClientFromConfig,
  vercelControlLayer
} from "./control.js"
