import { Schema, Effect, Option } from "effect"
import { normalise, type ArtifactPath } from "./path.js"
import { type Entry } from "./entry.js"

export class DuplicatePathError extends Schema.TaggedError<DuplicatePathError>()(
  "DuplicatePathError",
  {
    path: Schema.String
  }
) {}

/**
 * An ordered set of files to deploy, keyed by destination path.
 *
 * A Map rather than an array: O(1) duplicate detection, and Maps iterate in
 * insertion order, which is the deterministic iteration adapters depend on.
 * Artifacts are immutable, so every operation returns a new one.
 */
export interface Artifact {
  readonly entries: ReadonlyMap<ArtifactPath, Entry>
}

export const empty: Artifact = { entries: new Map() }

/** Copies rather than mutates, so one base artifact stays reusable across tenants. */
export const add = (artifact: Artifact, entry: Entry) => {
  return Effect.gen(function* () {
    if (artifact.entries.has(entry.path)) {
      return yield* new DuplicatePathError({ path: entry.path })
    }
    const updated = new Map(artifact.entries).set(entry.path, entry)
    return { entries: updated }
  })
}

/** Folds entries into one artifact, failing on the first duplicate. */
export const make = (entries: ReadonlyArray<Entry>) => {
  return Effect.gen(function* () {
    let artifact = empty

    for (const entry of entries) {
      artifact = yield* add(artifact, entry)
    }

    return artifact
  })
}

export const has = (artifact: Artifact, path: string) => {
  return Effect.gen(function* () {
    const normalPath = yield* normalise(path)
    return artifact.entries.has(normalPath)
  })
}

/** Absence is an answer, not a failure: the Option covers it, the error channel covers a bad path. */
export const get = (artifact: Artifact, path: string) => {
  return Effect.gen(function* () {
    const normalPath = yield* normalise(path)
    return Option.fromUndefinedOr(artifact.entries.get(normalPath))
  })
}

/** Insertion order, which adapters rely on when hashing and uploading. */
export const list = (artifact: Artifact): ReadonlyArray<Entry> => {
  return Array.from(artifact.entries.values())
}

export const fileCount = (artifact: Artifact): number => artifact.entries.size
