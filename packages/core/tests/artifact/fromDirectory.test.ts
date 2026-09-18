import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Option } from "effect"
import * as Artifact from "../../src/artifact/index.ts"

it.layer(NodeFileSystem.layer)("fromDirectory", it => {
  /** A small tree with nesting, an empty directory and a dotfile. */
  const tree = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${dir}/assets/img`, { recursive: true })
    yield* fs.makeDirectory(`${dir}/emptydir`)
    yield* fs.writeFileString(`${dir}/index.html`, "0123456789")
    yield* fs.writeFileString(`${dir}/assets/app.js`, "abc")
    yield* fs.writeFileString(`${dir}/assets/img/logo.png`, "xy")
    yield* fs.writeFileString(`${dir}/.DS_Store`, "z")
    return dir
  })

  describe("collecting files", () => {
    it.effect("walks nested directories and makes paths relative to the root", () =>
      Effect.gen(function* () {
        const artifact = yield* Artifact.fromDirectory(yield* tree)
        assert.deepStrictEqual(
          Artifact.list(artifact).map(e => e.path),
          [".DS_Store", "assets/app.js", "assets/img/logo.png", "index.html"]
        )
      })
    )

    it.effect("produces file entries that point back at the source on disk", () =>
      Effect.gen(function* () {
        const dir = yield* tree
        const artifact = yield* Artifact.fromDirectory(dir)
        const entry = Option.getOrThrow(yield* Artifact.get(artifact, "assets/app.js"))
        assert.strictEqual(entry._tag, "File", "directories are walked into, files are entries")
        if (entry._tag === "File") {
          assert.strictEqual(entry.source, `${dir}/assets/app.js`)
        }
      })
    )

    it.effect("does not add directories as entries", () =>
      Effect.gen(function* () {
        const artifact = yield* Artifact.fromDirectory(yield* tree)
        assert.strictEqual(Artifact.fileCount(artifact), 4, "four files, no directories")
        assert.isFalse(yield* Artifact.has(artifact, "assets"))
        assert.isFalse(yield* Artifact.has(artifact, "emptydir"))
      })
    )

    it.effect("keeps dotfiles, leaving that policy to the caller", () =>
      Effect.gen(function* () {
        const artifact = yield* Artifact.fromDirectory(yield* tree)
        assert.isTrue(yield* Artifact.has(artifact, ".DS_Store"))
      })
    )

    it.effect("sizes the whole tree from disk", () =>
      Effect.gen(function* () {
        const artifact = yield* Artifact.fromDirectory(yield* tree)
        assert.strictEqual(yield* Artifact.totalSize(artifact), 16)
      })
    )
  })

  describe("edge cases", () => {
    it.effect("returns an empty artifact for an empty directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        assert.strictEqual(Artifact.fileCount(yield* Artifact.fromDirectory(dir)), 0)
      })
    )

    it.effect("fails with a PlatformError when the root does not exist", () =>
      Effect.gen(function* () {
        const dir = yield* tree
        const error = yield* Effect.flip(Artifact.fromDirectory(`${dir}/nope`))
        assert.strictEqual(error._tag, "PlatformError")
      })
    )

    /**
     * `stat` follows symlinks, so a link to a file is collected like any other
     * file and its bytes are read from the link target at upload time. A link
     * pointing outside the root therefore escapes it. Documented deliberately:
     * the dogfood input is a trusted build directory, and link policy belongs
     * with whoever owns the untrusted input.
     */
    it.effect("follows a symlink to a file outside the root", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const outside = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${outside}/secret.txt`, "1234")

        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/a.txt`, "ab")
        yield* fs.symlink(`${outside}/secret.txt`, `${dir}/link.txt`)

        const artifact = yield* Artifact.fromDirectory(dir)
        assert.isTrue(yield* Artifact.has(artifact, "link.txt"))
        assert.strictEqual(yield* Artifact.totalSize(artifact), 6, "2 local + 4 through the link")
      })
    )

    /**
     * Directory listing order is not stable across filesystems, but an Artifact
     * promises deterministic iteration, so the same tree must always produce the
     * same order.
     */
    it.effect("produces the same order every time", () =>
      Effect.gen(function* () {
        const dir = yield* tree
        const first = yield* Artifact.fromDirectory(dir)
        const second = yield* Artifact.fromDirectory(dir)
        assert.deepStrictEqual(
          Artifact.list(first).map(e => e.path),
          Artifact.list(second).map(e => e.path)
        )
      })
    )
  })
})
