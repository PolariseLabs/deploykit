import { Effect, FileSystem, Match } from "effect"
import { type Entry } from "./entry.js"
import { list, type Artifact } from "./artifact.js"

/**
 * Size in UTF-8 bytes, which is how providers measure an upload.
 *
 * Text, Bytes and Deferred answer for free: the first two hold their content
 * and the third is told its length when it is created, because object stores
 * report size in a listing. Only File needs a syscall, which is why the whole
 * function requires a FileSystem even though most entries never touch it.
 */
export const sizeOf = (entry: Entry) =>
  Match.valueTags(entry, {
    Text: e => Effect.succeed(new TextEncoder().encode(e.content).length),
    Bytes: e => Effect.succeed(e.content.length),
    File: e =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const info = yield* fs.stat(e.source)
        // info.size is a branded bigint; artifacts sit far below MAX_SAFE_INTEGER.
        return Number(info.size)
      }),
    Deferred: e => Effect.succeed(e.byteLength)
  })

/** Bounded, or a 400 file dist opens 400 file handles at once. */
export const totalSize = (artifact: Artifact) =>
  Effect.forEach(list(artifact), sizeOf, { concurrency: 8 }).pipe(
    Effect.map(sizes => sizes.reduce((total, size) => total + size, 0))
  )
