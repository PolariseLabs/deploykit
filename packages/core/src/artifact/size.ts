import { Effect, FileSystem, Match } from "effect"
import { type Entry } from "./entry.js"
import { list, type Artifact } from "./artifact.js"

/**
 * Size in UTF-8 bytes, which is how providers measure an upload. Text and Bytes
 * answer for free; a File cannot without a syscall, so the whole function
 * requires a FileSystem.
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
      })
  })

/** Bounded, or a 400 file dist opens 400 file handles at once. */
export const totalSize = (artifact: Artifact) =>
  Effect.forEach(list(artifact), sizeOf, { concurrency: 8 }).pipe(
    Effect.map(sizes => sizes.reduce((total, size) => total + size, 0))
  )
