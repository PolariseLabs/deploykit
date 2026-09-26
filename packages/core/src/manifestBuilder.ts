import { createHash } from "node:crypto"
import { Effect, FileSystem, Stream } from "effect"
import * as Artifact from "./artifact/index.js"
import * as Manifest from "./manifest.js"
import { openEntry, validateEntries } from "./transfer.js"
import { IntegrityError, SourceError, ValidationError } from "./provider/errors.js"

export interface BuildOptions {
  /** Assign replayable storage references, never credentials or signed URLs. */
  readonly source: (path: string) => string
  readonly concurrency?: number
  readonly timeoutMs?: number
}

/** Hashes streams without collecting file contents; storage and snapshots remain caller-owned. */
export const fromArtifact = (artifact: Artifact.Artifact, options: BuildOptions) =>
  Effect.gen(function* () {
    const concurrency = options.concurrency ?? 4
    const timeoutMs = options.timeoutMs ?? 30000
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 32 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    )
      return yield* new ValidationError({ message: "Invalid manifest builder limits" })
    const entries = Artifact.list(artifact)
    yield* validateEntries(entries, Number.MAX_SAFE_INTEGER)
    const metadata = yield* Effect.try({
      try: () =>
        entries.map(entry => ({
          path: entry.path,
          source: options.source(entry.path),
          byteLength: Artifact.sizeOf(entry),
          sha256: "0".repeat(64)
        })),
      catch: () => new ValidationError({ message: "Cannot assign source references" })
    })
    yield* Manifest.decode({ version: 1, entries: metadata })
    const fs = yield* FileSystem.FileSystem
    const hashed = yield* Effect.forEach(
      entries,
      (entry, index) =>
        Effect.gen(function* () {
          const hash = createHash("sha256")
          const expected = metadata[index]!
          const mismatch = () =>
            new IntegrityError({ path: entry.path, message: "Source size or SHA-256 mismatch" })
          const bytes = yield* openEntry(fs, entry).pipe(
            Stream.runFoldEffect(
              () => 0,
              (size, chunk) =>
                Effect.gen(function* () {
                  const next = size + chunk.byteLength
                  if (next > expected.byteLength) return yield* mismatch()
                  hash.update(chunk)
                  return next
                })
            )
          )
          const sha256 = hash.digest("hex")
          if (bytes !== expected.byteLength || (entry._tag === "Source" && entry.sha256 !== sha256))
            return yield* mismatch()
          return {
            ...expected,
            sha256,
            ...(entry._tag === "Source" ? { fingerprints: entry.fingerprints } : {})
          }
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.catchTag(
            "TimeoutError",
            () =>
              new SourceError({ reference: entry.path, message: "Manifest source read timed out" })
          )
        ),
      { concurrency }
    )
    return yield* Manifest.decode({ version: 1, entries: hashed })
  })

/** Reads every file under the directory, including dotfiles; it does not copy or freeze them. */
export const fromDirectory = (directory: string, options: BuildOptions) =>
  Artifact.fromDirectory(directory).pipe(
    Effect.flatMap(artifact => fromArtifact(artifact, options))
  )
