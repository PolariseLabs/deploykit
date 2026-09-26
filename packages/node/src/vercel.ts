import { layer } from "@deploykit/vercel"
import type { VercelHttpConfig, DeployRequestOptions } from "@deploykit/vercel"
import { makeClient } from "./client.js"
import type { ClientOptions } from "./client.js"

export type VercelOptions = VercelHttpConfig & ClientOptions
export const createClient = (options: VercelOptions) =>
  makeClient<Pick<DeployRequestOptions, "uploadRounds" | "uploadConcurrency" | "uploadOrder">>(
    layer(options),
    options
  )
