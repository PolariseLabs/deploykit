import { fromPromiseGate } from "@deploykit/core/provider"
import { layer } from "@deploykit/vercel"
import type { DeployRequestOptions, UploadDefaults, VercelHttpConfig } from "@deploykit/vercel"
import { makeClient } from "./client.js"
import type { ClientOptions, GateOption } from "./client.js"

/** Upload tuning set here applies to every deploy; per-deploy options override it. */
export type VercelOptions = Omit<VercelHttpConfig, "gate"> &
  GateOption &
  ClientOptions &
  UploadDefaults
export const createClient = ({ gate, ...options }: VercelOptions) =>
  makeClient<Pick<DeployRequestOptions, "uploadRounds" | "uploadConcurrency" | "uploadOrder">>(
    layer({ ...options, ...(gate === undefined ? {} : { gate: fromPromiseGate(gate) }) }),
    options
  )
