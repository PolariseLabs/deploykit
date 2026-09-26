import { layer } from "@deploykit/vercel"
import type { DeployRequestOptions, UploadDefaults, VercelHttpConfig } from "@deploykit/vercel"
import { makeClient } from "./client.js"
import type { ClientOptions } from "./client.js"

/** Upload tuning set here applies to every deploy; per-deploy options override it. */
export type VercelOptions = VercelHttpConfig & ClientOptions & UploadDefaults
export const createClient = (options: VercelOptions) =>
  makeClient<Pick<DeployRequestOptions, "uploadRounds" | "uploadConcurrency" | "uploadOrder">>(
    layer(options),
    options
  )
