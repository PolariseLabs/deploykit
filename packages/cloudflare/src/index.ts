import { Effect, FileSystem, Layer } from "effect"
import * as Provider from "@deploykit/core/provider"
import { cloudflareClientFromConfig, makeCloudflareControl } from "./control.js"
import { deployToPagesProject } from "./services/deployments.js"
import type { CloudflareClient } from "./services/client.js"

const makeProvider = (
  cloudflare: CloudflareClient,
  fs: FileSystem.FileSystem
): Provider.Provider => ({
  ...makeCloudflareControl(cloudflare),
  deploy: (appId, artifact, options) =>
    deployToPagesProject(cloudflare, fs, appId, artifact, options)
})

/**
 * The Cloudflare Pages adapter.
 *
 * FileSystem stays a requirement rather than being provided here: the adapter
 * does not pick the caller's runtime, and only File entries ever reach it.
 */
export const cloudflareLayer = Layer.effect(
  Provider.DeploymentProvider,
  Effect.gen(function* () {
    const cloudflare = yield* cloudflareClientFromConfig
    return makeProvider(cloudflare, yield* FileSystem.FileSystem)
  })
)

export const layerWith = (client: CloudflareClient) =>
  Layer.effect(
    Provider.DeploymentProvider,
    Effect.map(FileSystem.FileSystem, fs => makeProvider(client, fs))
  )

export * from "./services/status.js"
export { CLOUDFLARE_DIGEST, pagesDigest } from "./services/digest.js"
export { makeCloudflareClient } from "./services/http.js"
export type { CloudflareHttpConfig } from "./services/http.js"
export { CloudflareApiError } from "./services/client.js"
export type { CloudflareClient } from "./services/client.js"
export {
  cloudflareClientFromConfig,
  cloudflareControlLayer,
  controlLayerWith,
  makeCloudflareControl
} from "./control.js"
