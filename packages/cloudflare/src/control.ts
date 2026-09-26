import { Config, Effect, Layer, Redacted } from "effect"
import * as Provider from "@deploykit/core/provider"
import {
  createPagesProject,
  deletePagesProject,
  findPagesProjectByName,
  getPagesProject
} from "./services/app.js"
import { getPagesDeployment } from "./services/read.js"
import { makeCloudflareClient } from "./services/http.js"
import type { CloudflareClient } from "./services/client.js"

export const makeCloudflareControl = (cloudflare: CloudflareClient): Provider.ControlPlane => ({
  name: "Cloudflare Pages",
  previewDeployments: cloudflare.previewBranch !== undefined,
  createApp: name => createPagesProject(cloudflare, name),
  getApp: id => getPagesProject(cloudflare, id),
  deleteApp: id => deletePagesProject(cloudflare, id),
  findAppByName: name => findPagesProjectByName(cloudflare, name),
  getDeployment: (appId, id) => getPagesDeployment(cloudflare, appId, id)
})

export const cloudflareClientFromConfig = Effect.gen(function* () {
  const apiToken = yield* Config.redacted("CLOUDFLARE_API_TOKEN")
  const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID")

  return makeCloudflareClient({
    apiToken: Redacted.value(apiToken),
    accountId
  })
})

export const cloudflareControlLayer = Layer.effect(
  Provider.DeploymentControl,
  Effect.map(cloudflareClientFromConfig, makeCloudflareControl)
)

export const controlLayerWith = (client: CloudflareClient) =>
  Layer.succeed(Provider.DeploymentControl, makeCloudflareControl(client))

export { makeCloudflareClient } from "./services/http.js"
export type { CloudflareHttpConfig } from "./services/http.js"
export { CloudflareApiError } from "./services/client.js"
export type { CloudflareClient } from "./services/client.js"
