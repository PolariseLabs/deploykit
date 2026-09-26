import { createHash } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Artifact, Entry, Manifest, Source } from "@deploykit/core"
import { fromArtifact, fromDirectory } from "../src/manifestBuilder.ts"

it.effect("directory manifests preserve paths and hash large files as streams", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    yield* fs.writeFileString(`${directory}/.config`, "🌍")
    const chunk = new Uint8Array(65536).fill(42)
    yield* Stream.fromIterable(Array.from({ length: 144 }, () => chunk)).pipe(
      Stream.run(fs.sink(`${directory}/large.bin`))
    )
    const expected = createHash("sha256")
    for (let i = 0; i < 144; i++) expected.update(chunk)
    const manifest = yield* fromDirectory(directory, { source: path => `blob:${path}` })
    assert.deepStrictEqual(
      manifest.entries.map(entry => entry.path),
      [".config", "large.bin"]
    )
    assert.strictEqual(manifest.entries[0]!.byteLength, 4)
    assert.strictEqual(manifest.entries[1]!.byteLength, 9 * 1024 * 1024)
    assert.strictEqual(manifest.entries[1]!.sha256, expected.digest("hex"))
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("invalid references fail before reading any source", () =>
  Effect.gen(function* () {
    let reads = 0
    const entry = yield* Entry.deferred("x", {
      byteLength: 1,
      read: async () => {
        reads++
        return new Uint8Array([1])
      }
    })
    const artifact = yield* Artifact.make([entry])
    const failure = yield* Effect.flip(
      fromArtifact(artifact, { source: () => "https://signed.invalid" })
    )
    assert.strictEqual(failure._tag, "ValidationError")
    assert.strictEqual(reads, 0)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("truncated, oversized and corrupt sources fail integrity and close their streams", () =>
  Effect.gen(function* () {
    for (const text of ["", "xx", "y"]) {
      let closed = false
      const artifact = yield* Manifest.toArtifact(
        {
          version: 1,
          entries: [
            {
              path: "x",
              source: "x",
              byteLength: 1,
              sha256: createHash("sha256").update("x").digest("hex")
            }
          ]
        },
        {
          open: () =>
            Stream.succeed(new TextEncoder().encode(text)).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  closed = true
                })
              )
            )
        }
      )
      const failure = yield* Effect.flip(fromArtifact(artifact, { source: path => path }))
      assert.strictEqual(failure._tag, "IntegrityError")
      assert.isTrue(closed)
    }
  }).pipe(Effect.provide(NodeFileSystem.layer))
)

it.effect("manifest deadlines abort stalled readers and stop later files", () =>
  Effect.gen(function* () {
    const opened = yield* Deferred.make<void>()
    let aborted = false
    let opens = 0
    const artifact = yield* Manifest.toArtifact(
      {
        version: 1,
        entries: ["a", "b"].map(path => ({
          path,
          source: path,
          byteLength: 1,
          sha256: "0".repeat(64)
        }))
      },
      Source.fromReadableStream(
        (_reference, signal) =>
          new Promise(() => {
            opens++
            signal.addEventListener("abort", () => {
              aborted = true
            })
            Deferred.doneUnsafe(opened, Effect.void)
          })
      )
    )
    const task = yield* fromArtifact(artifact, {
      source: path => path,
      concurrency: 1,
      timeoutMs: 1000
    }).pipe(Effect.flip, Effect.forkChild)
    yield* Deferred.await(opened)
    yield* TestClock.adjust("1 second")
    assert.strictEqual((yield* Fiber.join(task))._tag, "SourceError")
    assert.isTrue(aborted)
    assert.strictEqual(opens, 1)
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
