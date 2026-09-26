import { Effect, FileSystem, Layer } from "effect"
import * as Deploykit from "@deploykit/core/deploykit"
import * as Provider from "@deploykit/core/provider"
import { cloudflareClientFromConfig, makeCloudflareControl } from "./control.js"
import { deployToPagesProject } from "./services/deployments.js"
import type { CloudflareClient } from "./services/client.js"
import { makeCloudflareClient } from "./services/http.js"
import type { CloudflareHttpConfig } from "./services/http.js"

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

/** `Deploykit` on Cloudflare Pages: the layer most Effect apps want. Requires a `FileSystem`. */
export const layer = (options: CloudflareHttpConfig & Deploykit.Limits) =>
  Deploykit.layer(options).pipe(Layer.provide(layerWith(makeCloudflareClient(options))))

/** `layer`, reading credentials from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. */
export const layerConfig = (limits?: Deploykit.Limits) =>
  Deploykit.layer(limits).pipe(Layer.provide(cloudflareLayer))

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
