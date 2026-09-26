import { fromPromiseGate } from "@deploykit/core/provider"
import { layer } from "@deploykit/cloudflare"
import type { CloudflareHttpConfig } from "@deploykit/cloudflare"
import { makeClient } from "./client.js"
import type { ClientOptions, GateOption } from "./client.js"

export type CloudflareOptions = Omit<CloudflareHttpConfig, "gate"> & GateOption & ClientOptions
export const createClient = ({ gate, ...options }: CloudflareOptions) =>
  makeClient(
    layer({ ...options, ...(gate === undefined ? {} : { gate: fromPromiseGate(gate) }) }),
    options
  )
