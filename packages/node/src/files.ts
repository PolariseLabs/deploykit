import { Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Entry, Manifest, Source, Platform } from "@deploykit/core"
import * as Builder from "@deploykit/core/manifest-builder"
import { run } from "./runtime.js"
import type { RunOptions } from "./runtime.js"

export type FileInput =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly file: string }
export type { StreamReader } from "@deploykit/core/source"
export type { BuildOptions } from "@deploykit/core/manifest-builder"
export type { Artifact } from "@deploykit/core/artifact"
export type { Manifest } from "@deploykit/core/manifest"

export const artifactFromDirectory = (directory: string, options?: RunOptions) =>
  run(Artifact.fromDirectory(directory).pipe(Effect.provide(NodeFileSystem.layer)), options)

export const artifactFromFiles = (files: ReadonlyArray<FileInput>, options?: RunOptions) =>
  run(
    Effect.forEach(files, file =>
      Effect.gen(function* () {
        if ("text" in file) return yield* Entry.text(file.path, file.text)
        if ("bytes" in file) return yield* Entry.bytes(file.path, file.bytes)
        return yield* Entry.file(file.path, file.file)
      })
    ).pipe(Effect.flatMap(Artifact.make), Effect.provide(NodeFileSystem.layer)),
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

export const manifestFromArtifact = (
  artifact: Artifact.Artifact,
  options: Builder.BuildOptions & RunOptions
) =>
  run(Builder.fromArtifact(artifact, options).pipe(Effect.provide(NodeFileSystem.layer)), options)

export const manifestFromDirectory = (
  directory: string,
  options: Builder.BuildOptions & RunOptions
) =>
  run(Builder.fromDirectory(directory, options).pipe(Effect.provide(NodeFileSystem.layer)), options)

export const waitUntilServing = (
  url: string,
  options: Omit<Platform.ServingOptions, "schedule"> & RunOptions = {}
) => run(Platform.waitUntilServing(url, options), options)
