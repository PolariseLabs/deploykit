/**
 * Promise clients for runtimes without a filesystem, such as Cloudflare Workers
 * (with `nodejs_compat`, for `node:crypto` and `node:buffer`).
 *
 * Deploy from bytes, text or a manifest whose sources are fetched. Directory and
 * file entries are unavailable, and files are capped at 8 MiB because larger
 * ones are staged on disk.
 */

import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { Artifact, Entry, Manifest, Source } from "@deploykit/core"
import { makeClient } from "./client.js"
import type { ClientOptions } from "./client.js"
import { cloudflareLayer, vercelLayer } from "./layers.js"
import type { CloudflareOptions, VercelDeployExtras, VercelOptions } from "./layers.js"
import { run } from "./runtime.js"
import type { RunOptions } from "./runtime.js"

const unavailable = (method: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method,
      description: "No filesystem on this runtime"
    })
  )

const noFileSystem = FileSystem.layerNoop({
  makeTempFileScoped: () => unavailable("makeTempFileScoped"),
  makeTempDirectoryScoped: () => unavailable("makeTempDirectoryScoped")
})

/** Files larger than this would need disk staging. */
const maxEdgeFileBytes = 8 * 1024 * 1024

const edgeLimits = <O extends ClientOptions>(options: O): O => ({
  ...options,
  maxFileBytes: Math.min(options.maxFileBytes ?? maxEdgeFileBytes, maxEdgeFileBytes)
})

export const createVercelClient = (options: VercelOptions) =>
  makeClient<VercelDeployExtras>(
    vercelLayer(edgeLimits(options)).pipe(Layer.provide(noFileSystem)),
    options
  )

export const createCloudflareClient = (options: CloudflareOptions) =>
  makeClient(cloudflareLayer(edgeLimits(options)).pipe(Layer.provide(noFileSystem)), options)

export type EdgeFileInput =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly bytes: Uint8Array }

export const artifactFromFiles = (files: ReadonlyArray<EdgeFileInput>, options?: RunOptions) =>
  run(
    Effect.forEach(files, file =>
      Effect.gen(function* () {
        if ("text" in file) return yield* Entry.text(file.path, file.text)
        return yield* Entry.bytes(file.path, file.bytes)
      })
    ).pipe(Effect.flatMap(Artifact.make)),
    options
  )

export const artifactFromManifest = (
  manifest: unknown,
  read: Source.StreamReader,
  options?: RunOptions
) =>
  run(
    (typeof manifest === "string" ? Manifest.fromJson(manifest) : Manifest.decode(manifest)).pipe(
      Effect.flatMap(manifest => Manifest.toArtifact(manifest, Source.fromReadableStream(read)))
    ),
    options
  )

export type { VercelOptions, CloudflareOptions } from "./layers.js"
