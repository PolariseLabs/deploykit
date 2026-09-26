import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { Artifact, Entry, Manifest, Provider } from "@deploykit/core"
import * as Transfer from "@deploykit/core/transfer"

it.effect("validates file and directory collisions before transfer in either order", () =>
  Effect.gen(function* () {
    const budget = yield* Transfer.makeBudget()
    const parent = yield* Entry.text("config", "parent")
    const child = yield* Entry.text("config/app.json", "child")
    for (const entries of [
      [parent, child],
      [child, parent]
    ]) {
      assert.instanceOf(
        yield* Effect.flip(Transfer.validate(entries, budget)),
        Provider.ValidationError
      )
    }
  })
)

it.effect("a shared budget serializes overlapping jobs and rejects oversized reservations", () =>
  Effect.gen(function* () {
    const budget = yield* Transfer.makeBudget(100, 10)
    let active = 0
    let peak = 0
    const job = budget.use(
      60,
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active++
          peak = Math.max(peak, active)
        }),
        () => Effect.yieldNow,
        () =>
          Effect.sync(() => {
            active--
          })
      )
    )
    yield* Effect.all([job, job, job], { concurrency: "unbounded" })
    assert.strictEqual(peak, 1)
    assert.strictEqual(active, 0)
    assert.strictEqual(
      (yield* Effect.flip(budget.use(101, Effect.void)))._tag,
      "TransferLimitError"
    )
  })
)
it.effect("interruption closes sources and releases byte reservations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const budget = yield* Transfer.makeBudget(8388624, 1)
    const started = yield* Deferred.make<void>()
    let closed = false
    const artifact = yield* Manifest.toArtifact(
      { version: 1, entries: [{ path: "x", byteLength: 1, source: "x", sha256: "0".repeat(64) }] },
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
    const entry = Artifact.list(artifact)[0]!
    const fiber = yield* Transfer.withBytes(budget, fs, entry, () => Effect.void).pipe(
      Effect.forkChild
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.isTrue(closed)
    yield* budget.use(8388624, Effect.void)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
it.effect("promise reader receives cancellation and size limits fail before reads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const started = yield* Deferred.make<void>()
    let aborted = false
    const entry = yield* Entry.deferred("x", {
      byteLength: 1,
      read: signal =>
        new Promise(() => {
          signal?.addEventListener("abort", () => {
            aborted = true
          })
          Deferred.doneUnsafe(started, Effect.void)
        })
    })
    const budget = yield* Transfer.makeBudget(8388624, 1)
    const fiber = yield* Transfer.withBytes(budget, fs, entry, () => Effect.void).pipe(
      Effect.forkChild
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.isTrue(aborted)
    const oversized = yield* Entry.deferred("large", {
      byteLength: 2,
      read: async () => {
        throw new Error("must not read")
      }
    })
    assert.instanceOf(
      yield* Effect.flip(Transfer.validate([oversized], budget)),
      Provider.TransferLimitError
    )
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("reads UTF-8 text and chunked sources consistently across repeated runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const budget = yield* Transfer.makeBudget()
    const text = yield* Entry.text("text", "Hello 🌍")
    const encoded = yield* Transfer.withBytes(budget, fs, text, Effect.succeed)
    assert.deepStrictEqual(encoded, new TextEncoder().encode("Hello 🌍"))
    let opens = 0
    const artifact = yield* Manifest.toArtifact(
      {
        version: 1,
        entries: [
          {
            path: "chunked",
            byteLength: 3,
            source: "chunked",
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
          }
        ]
      },
      {
        open: () => {
          opens++
          return Stream.make(new Uint8Array([97]), new Uint8Array([98, 99]))
        }
      }
    )
    const read = Transfer.withBytes(budget, fs, Artifact.list(artifact)[0]!, Effect.succeed)
    assert.strictEqual(opens, 0)
    for (let run = 0; run < 2; run++) {
      assert.deepStrictEqual(yield* read, new Uint8Array([97, 98, 99]))
    }
    assert.strictEqual(opens, 2)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
