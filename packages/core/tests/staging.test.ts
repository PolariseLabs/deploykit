import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { Artifact, Entry, Manifest } from "@deploykit/core"
import { makeStagingBudget, openStagedBody, stageEntry } from "@deploykit/core/staging"

it.effect("stages verified bytes and removes the file when its scope closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const budget = yield* makeStagingBudget(10, 10)
    const entry = yield* Entry.text("a.txt", "abc")
    const path = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* stageEntry(fs, entry, budget)
        assert.strictEqual(file.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d")
        assert.strictEqual(yield* fs.readFileString(file.path), "abc")
        return file.path
      })
    )
    assert.isFalse(yield* fs.exists(path))
    yield* Effect.scoped(budget.reserve(10))
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("interruption closes the source, removes partial files and releases disk space", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    const budget = yield* makeStagingBudget(10, 10)
    const started = yield* Deferred.make<void>()
    let closed = false
    const artifact = yield* Manifest.toArtifact(
      {
        version: 1,
        entries: [
          {
            path: "x",
            source: "x",
            byteLength: 10,
            sha256: "0".repeat(64)
          }
        ]
      },
      {
        open: () =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          ).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                closed = true
              })
            )
          )
      }
    )
    const fiber = yield* Effect.scoped(
      stageEntry(localFs, Artifact.list(artifact)[0]!, budget)
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.isTrue(closed)
    assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
    yield* Effect.scoped(budget.reserve(10))
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect("rejects short, overflowing and corrupt sources and cleans up each failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const localFs = { ...fs, makeTempFileScoped: () => fs.makeTempFileScoped({ directory }) }
    const budget = yield* makeStagingBudget(10, 10)
    for (const length of [2, 3, 4]) {
      const artifact = yield* Manifest.toArtifact(
        {
          version: 1,
          entries: [
            {
              path: "x",
              source: "x",
              byteLength: 3,
              sha256: "0".repeat(64)
            }
          ]
        },
        { open: () => Stream.succeed(new Uint8Array(length)) }
      )
      const error = yield* Effect.flip(
        Effect.scoped(stageEntry(localFs, Artifact.list(artifact)[0]!, budget))
      )
      assert.strictEqual(error._tag, "IntegrityError")
      assert.deepStrictEqual(yield* fs.readDirectory(directory), [])
      yield* Effect.scoped(budget.reserve(10))
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
)

it.effect("scoped Web bodies close their producer even while a consumer holds the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let closed = false
    const sourceFs = {
      ...fs,
      stream: () =>
        Stream.never.pipe(
          Stream.ensuring(
            Effect.sync(() => {
              closed = true
            })
          )
        )
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const body = yield* openStagedBody(sourceFs, "unused")
        body.getReader()
      })
    )
    assert.isTrue(closed)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("disk-budget waiters can be cancelled without consuming a reservation", () =>
  Effect.gen(function* () {
    const budget = yield* makeStagingBudget(10, 10)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* budget.reserve(10)
        const waiting = yield* Effect.scoped(budget.reserve(10)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(waiting)
      })
    )
    yield* Effect.scoped(budget.reserve(10))
  })
)
