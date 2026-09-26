import { layer } from "@deploykit/cloudflare"
import type { CloudflareHttpConfig } from "@deploykit/cloudflare"
import { makeClient } from "./client.js"
import type { ClientOptions } from "./client.js"

export type CloudflareOptions = CloudflareHttpConfig & ClientOptions
export const createClient = (options: CloudflareOptions) => makeClient(layer(options), options)
