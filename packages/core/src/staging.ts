import { createHash } from "node:crypto"
import { Deferred, Effect, Fiber, Semaphore, Stream } from "effect"
import type { FileSystem, Scope } from "effect"
import type { Entry } from "./artifact/entry.js"
import { sizeOf } from "./artifact/size.js"
import { openEntry, validateEntries } from "./transfer.js"
import { IntegrityError, SourceError, TransferLimitError } from "./provider/errors.js"

export interface StagedFile {
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
  readonly sha1: string
}

export interface StagingBudget {
  readonly capacity: number
  readonly maxFileBytes: number
  readonly reserve: (bytes: number) => Effect.Effect<void, TransferLimitError, Scope.Scope>
}

/** Reserve disk space until the enclosing file scope closes. */
export const makeStagingBudget = (capacity = 256 * 1024 * 1024, maxFileBytes = 100_000_000) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      !Number.isSafeInteger(maxFileBytes) ||
      maxFileBytes < 0 ||
      maxFileBytes > capacity
    )
      return yield* new TransferLimitError({ message: "Invalid staging budget" })
    const semaphore = yield* Semaphore.make(capacity)
    const budget: StagingBudget = {
      capacity,
      maxFileBytes,
      reserve: bytes =>
        !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxFileBytes
          ? Effect.fail(new TransferLimitError({ message: "File exceeds staging budget" }))
          : Effect.acquireRelease(semaphore.take(bytes), () => semaphore.release(bytes), {
              interruptible: true
            }).pipe(Effect.asVoid)
    }
    return budget
  })

/** The scope owns both the temporary file and its disk reservation. */
export const stageEntry = (fs: FileSystem.FileSystem, entry: Entry, budget: StagingBudget) =>
  Effect.gen(function* () {
    yield* validateEntries([entry], budget.maxFileBytes)
    const size = sizeOf(entry)
    yield* budget.reserve(size)
    const failure = () => new SourceError({ reference: entry.path, message: "File staging failed" })
    const path = yield* fs
      .makeTempFileScoped({ prefix: "deploykit-" })
      .pipe(Effect.mapError(failure))
    const sha256 = createHash("sha256")
    const sha1 = createHash("sha1")
    let received = 0
    yield* openEntry(fs, entry).pipe(
      Stream.tap(chunk =>
        Effect.gen(function* () {
          received += chunk.byteLength
          if (received > size)
            return yield* new IntegrityError({
              path: entry.path,
              message: "Source exceeds declared size"
            })
          sha256.update(chunk)
          sha1.update(chunk)
        })
      ),
      Stream.run(fs.sink(path)),
      Effect.catchTag("PlatformError", failure),
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", failure)
    )
    const contentHash = sha256.digest("hex")
    if (received !== size || (entry._tag === "Source" && contentHash !== entry.sha256))
      return yield* new IntegrityError({
        path: entry.path,
        message: "Source size or SHA-256 mismatch"
      })
    return { path, byteLength: size, sha256: contentHash, sha1: sha1.digest("hex") }
  })

/** Interrupt the producer on scope exit even if fetch still holds the Web stream lock. */
export const openStreamBody = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
      const body = yield* stream.pipe(
        Stream.onStart(Effect.withFiber(fiber => Deferred.succeed(started, fiber))),
        stream => Stream.toReadableStreamEffect(stream)
      )
      const producer = yield* Deferred.await(started)
      return { body, producer }
    }),
    ({ producer }) => Fiber.interrupt(producer)
  ).pipe(Effect.map(({ body }) => body))

export const openStagedBody = (fs: FileSystem.FileSystem, path: string) =>
  openStreamBody(fs.stream(path, { chunkSize: 65536 }))
