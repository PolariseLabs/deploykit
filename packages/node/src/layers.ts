/** Provider layers for the Promise clients. No runtime imports here: entry points add the filesystem. */

import { fromPromiseGate } from "@deploykit/core/provider"
import * as Cloudflare from "@deploykit/cloudflare"
import type { CloudflareHttpConfig } from "@deploykit/cloudflare"
import * as Vercel from "@deploykit/vercel"
import type { DeployRequestOptions, UploadDefaults, VercelHttpConfig } from "@deploykit/vercel"
import type { ClientOptions, GateOption } from "./client.js"

/** Upload tuning set here applies to every deploy; per-deploy options override it. */
export type VercelOptions = Omit<VercelHttpConfig, "gate"> &
  GateOption &
  ClientOptions &
  UploadDefaults
export type VercelDeployExtras = Pick<
  DeployRequestOptions,
  "uploadRounds" | "uploadConcurrency" | "uploadOrder"
>
export type CloudflareOptions = Omit<CloudflareHttpConfig, "gate"> & GateOption & ClientOptions

const withGate = <O extends GateOption>({ gate, ...options }: O) => ({
  ...options,
  ...(gate === undefined ? {} : { gate: fromPromiseGate(gate) })
})

export const vercelLayer = (options: VercelOptions) => Vercel.layer(withGate(options))
export const cloudflareLayer = (options: CloudflareOptions) => Cloudflare.layer(withGate(options))
