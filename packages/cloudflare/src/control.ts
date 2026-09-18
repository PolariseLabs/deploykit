/**
 * The Cloudflare Pages control plane, carrying no deploy code.
 *
 * Same shape as the Vercel adapter's, and for the same reason: everything
 * here is a small HTTP call, while deploying moves a tree of bytes and pulls
 * in a hasher.
 *
 * Note what is absent. There is no `setAccess`, so `accessModes` is empty and
 * `capabilitiesOf` reports the capability as unavailable. Cloudflare protects
 * preview deployments through Cloudflare Access policies, which is not the
 * same shape as Vercel's per-project password or SSO toggle. Rather than
 * pretend, the adapter declares it does not do it, and Platform refuses with
 * UnsupportedError instead of failing somewhere deeper.
 */

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
