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
  /**
   * Size at the moment the entry was made.
   *
   * Carried rather than measured later so sizing a tree is free. The stat
   * happens here, where the caller is already reaching for the filesystem,
   * instead of making every measurement of every entry require one.
   */
  byteLength: Schema.Number
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
  /**
   * Digests the caller already knows, keyed by algorithm.
   *
   * A record rather than a `sha1` field, because the digest a provider wants
   * is the provider's business. Vercel addresses uploads by hex sha1 of the
   * bytes; Cloudflare Pages hashes sha256 over base64 content plus the file
   * extension. A single named field would have made one of them the default
   * and the other a special case.
   *
   * Supplying one is what lets a republish skip reading a file at all: the
   * manifest can be built, and the provider asked what it is missing, without
   * ever fetching the bytes. An adapter that finds no key it recognises
   * simply reads and hashes as usual.
   */
  readonly digests?: Readonly<Record<string, string>>
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

/**
 * The same, for a caller that has already stat-ed the file. Saves a second
 * syscall per entry when walking a directory, which at a thousand files is
 * the difference worth having.
 */
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
export const isResident = (entry: Entry): boolean => entry._tag !== "Deferred"
