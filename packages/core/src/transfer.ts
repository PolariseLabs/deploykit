import * as Telemetry from "./telemetry.js"
import { createHash } from "node:crypto"
import { Effect, Semaphore, Stream } from "effect"
import type { FileSystem } from "effect"
import type { Entry } from "./artifact/entry.js"
import { sizeOf } from "./artifact/size.js"
import { normalise } from "./artifact/path.js"
import {
  IntegrityError,
  SourceError,
  TransferLimitError,
  ValidationError
} from "./provider/errors.js"

/** Reservations cover buffers and encoding while the request is in flight. */
export interface TransferBudget {
  readonly capacity: number
  readonly maxFileBytes: number
  readonly use: <A, E, R>(
    bytes: number,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | TransferLimitError, R>
}

export const makeBudget = (capacity = 256 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      !Number.isSafeInteger(maxFileBytes) ||
      maxFileBytes < 0 ||
      maxFileBytes > 8 * 1024 * 1024
    ) {
      return yield* new TransferLimitError({ message: "Invalid transfer budget" })
    }
    const semaphore = yield* Semaphore.make(capacity)
    const budget: TransferBudget = {
      capacity,
      maxFileBytes,
      use: (bytes, effect) =>
        bytes > capacity || bytes < 0 || !Number.isSafeInteger(bytes)
          ? Effect.fail(new TransferLimitError({ message: "Transfer exceeds shared byte budget" }))
          : semaphore.withPermits(bytes)(effect)
    }
    return budget
  })

/** Conservative supported buffered path, including base64/JSON/hash temporaries. */
export const reservation = (entry: Entry) => sizeOf(entry) * 16 + 8 * 1024 * 1024

export const validateEntries = (entries: ReadonlyArray<Entry>, maxFileBytes: number) =>
  Effect.gen(function* () {
    if (entries.length > 20000)
      return yield* new TransferLimitError({ message: "At most 20000 files are supported" })
    const seen = new Set<string>()
    for (const entry of entries) {
      const path = yield* normalise(entry.path).pipe(
        Effect.mapError(() => new ValidationError({ message: "Unsafe destination path" }))
      )
      if (path !== entry.path || seen.has(path))
        return yield* new ValidationError({ message: "Non-canonical or duplicate path" })
      seen.add(path)
      if (entry._tag === "Source" && !/^[a-f0-9]{64}$/.test(entry.sha256))
        return yield* new ValidationError({ message: "Invalid content identity" })
      const size = sizeOf(entry)
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
        return yield* new TransferLimitError({ message: `Unsupported file size: ${entry.path}` })
      }
    }
    for (const path of seen) {
      const parts = path.split("/")
      parts.pop()
      while (parts.length > 0) {
        if (seen.has(parts.join("/")))
          return yield* new ValidationError({ message: "File and directory paths collide" })
        parts.pop()
      }
    }
  })

export const validate = (entries: ReadonlyArray<Entry>, budget: TransferBudget) =>
  validateEntries(entries, budget.maxFileBytes).pipe(
    Effect.andThen(() =>
      entries.some(entry => reservation(entry) > budget.capacity)
        ? Effect.fail(new TransferLimitError({ message: "Transfer exceeds shared byte budget" }))
        : Effect.void
    )
  )

/** Open each entry as a lazy byte stream. */
export const openEntry = (fs: FileSystem.FileSystem, entry: Entry) => {
  const failure = () => new SourceError({ reference: entry.path, message: "Source read failed" })
  switch (entry._tag) {
    case "Source":
      return Stream.suspend(entry.open)
    case "Text":
      return Stream.succeed(entry.content).pipe(Stream.encodeText)
    case "Bytes":
      return Stream.succeed(entry.content)
    case "File":
      return fs.stream(entry.source, { chunkSize: 65536 }).pipe(Stream.mapError(failure))
    case "Deferred":
      return Stream.fromEffect(
        Effect.tryPromise({ try: signal => entry.read(signal), catch: failure })
      )
    default: {
      const exhaustive: never = entry
      return exhaustive
    }
  }
}

/** Collect only the declared size while verifying content integrity. */
const read = (fs: FileSystem.FileSystem, entry: Entry) =>
  Effect.gen(function* () {
    const size = sizeOf(entry)
    const bytes = new Uint8Array(size)
    const hash = createHash("sha256")
    const offset = yield* openEntry(fs, entry).pipe(
      Stream.runFoldEffect(
        () => 0,
        (offset, chunk) =>
          Effect.gen(function* () {
            if (offset + chunk.byteLength > size)
              return yield* new IntegrityError({
                path: entry.path,
                message: "Source exceeds declared size"
              })
            bytes.set(chunk, offset)
            hash.update(chunk)
            return offset + chunk.byteLength
          })
      ),
      Effect.timeout("30 seconds"),
      Effect.catchTag(
        "TimeoutError",
        () => new SourceError({ reference: entry.path, message: "Source read deadline exceeded" })
      )
    )
    if (offset !== size || (entry._tag === "Source" && hash.digest("hex") !== entry.sha256)) {
      return yield* new IntegrityError({
        path: entry.path,
        message: "Source size or SHA-256 mismatch"
      })
    }
    return bytes
  })

export const withBytes = <A, E, R>(
  budget: TransferBudget,
  fs: FileSystem.FileSystem,
  entry: Entry,
  use: (bytes: Uint8Array) => Effect.Effect<A, E, R>
) =>
  validate([entry], budget).pipe(
    Effect.andThen(
      budget.use(
        reservation(entry),
        Effect.suspend(() =>
          Telemetry.observe("core", "read", read(fs, entry), { bytes: sizeOf(entry) }).pipe(
            Effect.flatMap(use)
          )
        )
      )
    )
  )

export const fingerprint = (
  entry: Entry,
  recipe: string,
  context: string,
  legacyKey: string
): string | undefined =>
  entry._tag === "Source"
    ? entry.fingerprints.find(value => value.recipe === recipe && value.context === context)?.value
    : entry._tag === "Deferred"
      ? entry.digests?.[legacyKey]
      : undefined

export const checkFingerprint = (path: string, expected: string, actual: string) =>
  expected === actual
    ? Effect.void
    : Effect.fail(new IntegrityError({ path, message: "Provider fingerprint mismatch" }))
