import { operations } from "./services/operations.js"

import { Config, Effect, Layer, Redacted } from "effect"
// The provider subpath, not the barrel: importing the barrel would pull the
// artifact module and its filesystem code into a bundle that never reads a file.
import * as Provider from "@deploykit/core/provider"
import {
  createVercelProject,
  deleteVercelProject,
  findVercelProjectByName,
  getVercelProject,
  setVercelProjectAccess
} from "./services/app.js"
import { getDeployment } from "./services/status.js"
import { makeVercelClient } from "./services/http.js"
import type { VercelClient } from "./services/client.js"

/** The control-plane half of the adapter, over a client the caller built. */
export const makeVercelControl = (vercel: VercelClient): Provider.ControlPlane => ({
  name: "Vercel",
  ...operations(vercel),
  createApp: name => createVercelProject(vercel, name),
  getApp: id => getVercelProject(vercel, id),
  deleteApp: id => deleteVercelProject(vercel, id),
  findAppByName: name => findVercelProjectByName(vercel, name),
  setAccess: (id, access) => setVercelProjectAccess(vercel, id, access),
  accessModes: new Set<Provider.AccessMode>(["public", "password", "sso"]),
  getDeployment: (appId, id) => getDeployment(vercel, appId, id)
})

/** Reads VERCEL_TOKEN, falling back to VERCEL_API_KEY, plus VERCEL_TEAM_ID. */
export const vercelClientFromConfig = Effect.gen(function* () {
  const token = yield* Config.redacted("VERCEL_TOKEN").pipe(
    Config.orElse(() => Config.redacted("VERCEL_API_KEY"))
  )
  const teamId = yield* Config.option(Config.string("VERCEL_TEAM_ID"))

  return makeVercelClient({
    token: Redacted.value(token),
    ...(teamId._tag === "Some" ? { teamId: teamId.value } : {})
  })
})

export const vercelControlLayer = Layer.effect(
  Provider.DeploymentControl,
  Effect.map(vercelClientFromConfig, makeVercelControl)
)

/** The same over a client the caller built, which is also the escape hatch. */
export const controlLayerWith = (client: VercelClient) =>
  Layer.succeed(Provider.DeploymentControl, makeVercelControl(client))

export { makeVercelClient } from "./services/http.js"
export type { VercelHttpConfig } from "./services/http.js"
export { VercelApiError } from "./services/client.js"
export type { VercelClient } from "./services/client.js"
