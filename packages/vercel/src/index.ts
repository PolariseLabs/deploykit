import { operations } from "./services/operations.js"
import { Config, Effect, FileSystem, Layer, Redacted } from "effect"
import { Deploykit, Provider } from "@deploykit/core"
import {
  createVercelProject,
  deleteVercelProject,
  findVercelProjectByName,
  getVercelProject,
  setVercelProjectAccess
} from "./services/app.js"
import { deployToVercelProject } from "./services/deployments.js"
import type { DeployRequestOptions } from "./services/deployments.js"
import { getDeployment } from "./services/status.js"
import { makeVercelClient } from "./services/http.js"
import { vercelClientFromConfig } from "./control.js"
import type { VercelClient } from "./services/client.js"
import type { VercelHttpConfig } from "./services/http.js"

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
export const layerWith = (client: VercelClient, defaults: UploadDefaults = {}) =>
  Layer.effect(
    Provider.DeploymentProvider,
    Effect.map(FileSystem.FileSystem, fs => makeProvider(client, fs, defaults))
  )

/** `Deploykit` on Vercel: the layer most Effect apps want. Requires a `FileSystem`. */
export const layer = (options: VercelHttpConfig & Deploykit.Limits & UploadDefaults) =>
  Deploykit.layer(options).pipe(
    Layer.provide(layerWith(makeVercelClient(options), uploadDefaults(options)))
  )

/** `layer`, reading credentials from `VERCEL_TOKEN` and `VERCEL_TEAM_ID`. */
export const layerConfig = (options: Deploykit.Limits & UploadDefaults = {}) =>
  Deploykit.layer(options).pipe(
    Layer.provide(
      Layer.effect(
        Provider.DeploymentProvider,
        Effect.gen(function* () {
          const client = yield* vercelClientFromConfig
          return makeProvider(client, yield* FileSystem.FileSystem, uploadDefaults(options))
        })
      )
    )
  )

/** Upload tuning set once for every deploy; a deploy's own options still win. */
export type UploadDefaults = Pick<
  DeployRequestOptions,
  "uploadRounds" | "uploadConcurrency" | "uploadOrder"
>

const uploadDefaults = ({
  uploadRounds,
  uploadConcurrency,
  uploadOrder
}: UploadDefaults): UploadDefaults => ({
  ...(uploadRounds === undefined ? {} : { uploadRounds }),
  ...(uploadConcurrency === undefined ? {} : { uploadConcurrency }),
  ...(uploadOrder === undefined ? {} : { uploadOrder })
})

const makeProvider = (
  vercel: VercelClient,
  fs: FileSystem.FileSystem,
  defaults: UploadDefaults = {}
): Provider.Provider => ({
  name: "Vercel",
  ...operations(vercel),
  createApp: name => createVercelProject(vercel, name),
  getApp: id => getVercelProject(vercel, id),
  deleteApp: id => deleteVercelProject(vercel, id),
  findAppByName: name => findVercelProjectByName(vercel, name),
  setAccess: (id, access) => setVercelProjectAccess(vercel, id, access),
  accessModes: new Set<Provider.AccessMode>(["public", "password", "sso"]),
  deploy: (appId, artifact, options) =>
    deployToVercelProject(vercel, fs, appId, artifact, { ...defaults, ...options }),
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

export { uploadThrottlePresets } from "./services/throttle.js"
export type { UploadThrottle, UploadThrottleLimits } from "./services/throttle.js"
