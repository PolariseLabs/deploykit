import { utf8Length } from "./pathRules.js"
import { Match } from "effect"
import { type Entry } from "./entry.js"
import { list, type Artifact } from "./artifact.js"

export const sizeOf = (entry: Entry): number =>
  Match.valueTags(entry, {
    Text: e => utf8Length(e.content),
    Bytes: e => e.content.length,
    File: e => e.byteLength,
    Source: e => e.byteLength,
    Deferred: e => e.byteLength
  })

export const totalSize = (artifact: Artifact): number =>
  list(artifact).reduce((total, entry) => total + sizeOf(entry), 0)
