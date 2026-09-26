import { Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { makeClient } from "./client.js"
import { cloudflareLayer } from "./layers.js"
import type { CloudflareOptions } from "./layers.js"

export type { CloudflareOptions } from "./layers.js"
export const createClient = (options: CloudflareOptions) =>
  makeClient(cloudflareLayer(options).pipe(Layer.provide(NodeFileSystem.layer)), options)
