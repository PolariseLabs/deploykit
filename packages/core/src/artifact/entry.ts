import type { Stream } from "effect"
import type { SourceError } from "../provider/errors.js"
import { Schema, Effect, FileSystem, Match } from "effect"
import type { ArtifactPath } from "./path.js"
import { normalise, ArtifactPathSchema } from "./path.js"

export class TextEntry extends Schema.TaggedClass<TextEntry>()("Text", {
  path: ArtifactPathSchema,
  content: Schema.String
}) {}

export class BytesEntry extends Schema.TaggedClass<BytesEntry>()("Bytes", {
  path: ArtifactPathSchema,
  content: Schema.Uint8Array
}) {}

export class FileEntry extends Schema.TaggedClass<FileEntry>()("File", {
  path: ArtifactPathSchema,
  source: Schema.String,

  byteLength: Schema.Number
}) {}

export interface DeferredEntry {
  readonly _tag: "Deferred"
  readonly path: ArtifactPath
  readonly byteLength: number
  readonly read: (signal?: AbortSignal) => Promise<Uint8Array>

  readonly digests?: Readonly<Record<string, string>>
}

export interface SourceEntry {
  readonly _tag: "Source"
  readonly path: ArtifactPath
  readonly byteLength: number
  readonly sha256: string
  readonly fingerprints: ReadonlyArray<{
    readonly recipe: string
    readonly context: string
    readonly value: string
  }>
  readonly open: () => Stream.Stream<Uint8Array, SourceError>
}

export type Entry = TextEntry | BytesEntry | FileEntry | DeferredEntry | SourceEntry

export const text = (path: string, content: string) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new TextEntry({ path: NormalPath, content })
  })
}

export const bytes = (path: string, content: Uint8Array) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new BytesEntry({ path: NormalPath, content })
  })
}

/** Reads the size now, so nothing has to read it again. */
export const file = (path: string, source: string) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(source)
    // info.size is a branded bigint; artifacts sit far below MAX_SAFE_INTEGER.
    return new FileEntry({ path: NormalPath, source, byteLength: Number(info.size) })
  })
}

export const fileWithSize = (path: string, source: string, byteLength: number) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new FileEntry({ path: NormalPath, source, byteLength })
  })
}

export const describe = (entry: Entry) => {
  return Match.valueTags(entry, {
    Text: ({ path, content }) => `text ${path} with ${content.length} characters`,
    Bytes: ({ path, content }) => `bytes ${path} with ${content.length} bytes`,
    File: ({ path, source }) => `file ${path} from ${source}`,
    Source: ({ path, byteLength }) => `source ${path}, ${byteLength} bytes`,
    Deferred: ({ path, byteLength }) => `deferred ${path}, ${byteLength} bytes`
  })
}

export const deferred = (
  path: string,
  options: {
    readonly byteLength: number
    readonly read: (signal?: AbortSignal) => Promise<Uint8Array>
    readonly digests?: Readonly<Record<string, string>>
  }
) =>
  Effect.gen(function* () {
    const normalPath = yield* normalise(path)
    const entry: DeferredEntry = {
      _tag: "Deferred",
      path: normalPath,
      byteLength: options.byteLength,
      read: options.read,
      ...(options.digests !== undefined ? { digests: options.digests } : {})
    }
    return entry
  })

/** True when the bytes are already in hand, so reading them costs nothing. */
export const isResident = (entry: Entry): boolean => entry._tag === "Text" || entry._tag === "Bytes"
