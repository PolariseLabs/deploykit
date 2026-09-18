import { Schema, Effect, Match } from "effect"
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
  source: Schema.String
}) {}

/**
 * A file whose bytes are not in memory and will be fetched when needed.
 *
 * Not a Schema class, because `read` is a function and no schema describes
 * one. That is the honest shape: a deferred entry is a handle, not data, and
 * it cannot be serialised. What crosses a process boundary is the manifest
 * (path, size, digest) with the reader supplied again on the other side.
 *
 * `byteLength` is required and known without reading. Object stores return it
 * in a listing and upload records keep it, so sizing a tree costs nothing.
 * `sha1` is the same idea for content: when the caller already knows it, the
 * bytes never have to be fetched merely to be hashed, which is the difference
 * between a fast republish and a slow one.
 */
export interface DeferredEntry {
  readonly _tag: "Deferred"
  readonly path: ArtifactPath
  readonly byteLength: number
  readonly read: (signal?: AbortSignal) => Promise<Uint8Array>
  /** Hex sha1 of the content, when the caller already knows it. */
  readonly sha1?: string
}

export type Entry = TextEntry | BytesEntry | FileEntry | DeferredEntry

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

export const file = (path: string, source: string) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new FileEntry({ path: NormalPath, source })
  })
}

export const describe = (entry: Entry) => {
  return Match.valueTags(entry, {
    Text: ({ path, content }) => `text ${path} with ${content.length} characters`,
    Bytes: ({ path, content }) => `bytes ${path} with ${content.length} bytes`,
    File: ({ path, source }) => `file ${path} from ${source}`,
    Deferred: ({ path, byteLength }) => `deferred ${path}, ${byteLength} bytes`
  })
}

/**
 * A file the caller will fetch on demand.
 *
 * Defer by role, not by size. Text that a later stage rewrites should stay
 * eager, because deferring it only moves the read; media that nothing between
 * here and upload touches is where deferring takes a whole tree out of memory.
 */
export const deferred = (
  path: string,
  options: {
    readonly byteLength: number
    readonly read: (signal?: AbortSignal) => Promise<Uint8Array>
    readonly sha1?: string
  }
) =>
  Effect.gen(function* () {
    const normalPath = yield* normalise(path)
    const entry: DeferredEntry = {
      _tag: "Deferred",
      path: normalPath,
      byteLength: options.byteLength,
      read: options.read,
      ...(options.sha1 !== undefined ? { sha1: options.sha1 } : {})
    }
    return entry
  })

/** True when the bytes are already in hand, so reading them costs nothing. */
export const isResident = (entry: Entry): boolean => entry._tag !== "Deferred"
