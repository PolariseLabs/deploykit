import { Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { makeClient } from "./client.js"
import { vercelLayer } from "./layers.js"
import type { VercelDeployExtras, VercelOptions } from "./layers.js"

export type { VercelOptions } from "./layers.js"
export const createClient = (options: VercelOptions) =>
  makeClient<VercelDeployExtras>(
    vercelLayer(options).pipe(Layer.provide(NodeFileSystem.layer)),
    options
  )
