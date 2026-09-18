import { Match } from "effect"
import { type Entry } from "./entry.js"
import { list, type Artifact } from "./artifact.js"

/**
 * Size in UTF-8 bytes, which is how providers measure an upload.
 *
 * Pure, and free for every entry kind. Text and Bytes hold their content; a
 * deferred entry is told its length because object stores report it in a
 * listing; a file entry stat-ed once when it was created. Measuring a tree
 * used to require a FileSystem for the sake of one branch, which meant a
 * caller with no filesystem at all had to supply one it did not have.
 */
export const sizeOf = (entry: Entry): number =>
  Match.valueTags(entry, {
    Text: e => new TextEncoder().encode(e.content).length,
    Bytes: e => e.content.length,
    File: e => e.byteLength,
    Deferred: e => e.byteLength
  })

export const totalSize = (artifact: Artifact): number =>
  list(artifact).reduce((total, entry) => total + sizeOf(entry), 0)
