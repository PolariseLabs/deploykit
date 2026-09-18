import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import * as Artifact from "../../src/artifact/index.ts"
import * as Entry from "../../src/artifact/entry.ts"

/**
 * The first tests in the project that need a service. `sizeOf` declares that it
 * requires a FileSystem and nothing runs until a Layer supplies one; here that
 * is the real Node filesystem, because the point is to prove the syscall path
 * works rather than to mock it away.
 */
it.layer(NodeFileSystem.layer)("with a filesystem", it => {
  const scratch = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    yield* fs.writeFileString(`${dir}/ten.txt`, "0123456789")
    yield* fs.writeFileString(`${dir}/empty.txt`, "")
    return dir
  })

  describe("sizeOf", () => {
    it.effect("counts UTF-8 bytes for text, not UTF-16 code units", () =>
      Effect.gen(function* () {
        const entry = yield* Entry.text("cafe.txt", "café")
        assert.strictEqual(entry.content.length, 4, "the string is 4 code units")
        assert.strictEqual(yield* Artifact.sizeOf(entry), 5, "but 5 bytes on the wire")
      })
    )

    it.effect("counts bytes directly for a byte entry", () =>
      Effect.gen(function* () {
        const entry = yield* Entry.bytes("logo.png", new Uint8Array([1, 2, 3]))
        assert.strictEqual(yield* Artifact.sizeOf(entry), 3)
      })
    )

    it.effect("reads the size of a file entry from disk", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const entry = yield* Entry.file("ten.txt", `${dir}/ten.txt`)
        assert.strictEqual(yield* Artifact.sizeOf(entry), 10)
      })
    )

    it.effect("reports zero for an empty file", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const entry = yield* Entry.file("empty.txt", `${dir}/empty.txt`)
        assert.strictEqual(yield* Artifact.sizeOf(entry), 0)
      })
    )

    it.effect("fails with a PlatformError when the source is missing", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const entry = yield* Entry.file("gone.txt", `${dir}/gone.txt`)
        const error = yield* Effect.flip(Artifact.sizeOf(entry))
        assert.strictEqual(error._tag, "PlatformError")
      })
    )
  })

  describe("totalSize", () => {
    it.effect("is zero for an empty artifact", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* Artifact.totalSize(Artifact.empty), 0)
      })
    )

    it.effect("sums every variant together", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const artifact = yield* Artifact.make([
          yield* Entry.text("cafe.txt", "café"), // 5
          yield* Entry.bytes("logo.png", new Uint8Array(3)), // 3
          yield* Entry.file("ten.txt", `${dir}/ten.txt`) // 10
        ])
        assert.strictEqual(yield* Artifact.totalSize(artifact), 18)
      })
    )

    it.effect("fails if any single source is unreadable", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const artifact = yield* Artifact.make([
          yield* Entry.text("a.txt", "ok"),
          yield* Entry.file("gone.txt", `${dir}/gone.txt`)
        ])
        const error = yield* Effect.flip(Artifact.totalSize(artifact))
        assert.strictEqual(error._tag, "PlatformError")
      })
    )

    /**
     * Bounded concurrency must not drop or reorder work. Sizing more entries
     * than the concurrency limit is the cheap way to catch a fold that loses
     * elements once more than one fiber is in flight.
     */
    it.effect("sizes more entries than its concurrency limit", () =>
      Effect.gen(function* () {
        const dir = yield* scratch
        const entries = yield* Effect.forEach(
          Array.from({ length: 25 }, (_, i) => i),
          i => Entry.file(`copy-${i}.txt`, `${dir}/ten.txt`)
        )
        const artifact = yield* Artifact.make(entries)
        assert.strictEqual(yield* Artifact.totalSize(artifact), 250)
      })
    )
  })
})

describe("deferred entries", () => {
  /**
   * The reason sizing is free. An object store reports size in its listing, so
   * a deferred entry is told its length when it is made and never has to be
   * fetched to be measured.
   */
  it.effect("reports the length it was given, without reading", () =>
    Effect.gen(function* () {
      let reads = 0
      const entry = yield* Entry.deferred("big.bin", {
        byteLength: 4096,
        read: () => {
          reads += 1
          return Promise.resolve(new Uint8Array(4096))
        }
      })

      assert.strictEqual(yield* Artifact.sizeOf(entry), 4096)
      assert.strictEqual(reads, 0, "measuring must not fetch")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("totals a mixed tree without fetching the deferred parts", () =>
    Effect.gen(function* () {
      let reads = 0
      const artifact = yield* Artifact.make([
        yield* Entry.text("index.html", "hello"),
        yield* Entry.deferred("video.mp4", {
          byteLength: 1_000_000,
          read: () => {
            reads += 1
            return Promise.resolve(new Uint8Array(0))
          }
        })
      ])

      assert.strictEqual(yield* Artifact.totalSize(artifact), 1_000_005)
      assert.strictEqual(reads, 0)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("says which entries are already in hand", () =>
    Effect.gen(function* () {
      const text = yield* Entry.text("a.txt", "a")
      const lazy = yield* Entry.deferred("b.bin", {
        byteLength: 1,
        read: () => Promise.resolve(new Uint8Array([1]))
      })

      assert.isTrue(Entry.isResident(text))
      assert.isFalse(Entry.isResident(lazy))
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})
