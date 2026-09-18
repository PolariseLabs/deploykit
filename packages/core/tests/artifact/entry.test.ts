import { assert, describe as suite, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Entry from "../../src/artifact/entry.ts"

/**
 * Entries are pure descriptions of one deployed file. The only way to build one
 * is through a constructor that normalises the destination path first, so an
 * entry can never hold a path that `normalise` would have rejected.
 */

suite("Entry constructors", () => {
  it.effect("text carries its content and tag", () =>
    Effect.gen(function* () {
      const entry = yield* Entry.text("config.json", '{"theme":"dark"}')
      assert.strictEqual(entry._tag, "Text")
      assert.strictEqual(entry.path, "config.json")
      assert.strictEqual(entry.content, '{"theme":"dark"}')
    })
  )

  it.effect("bytes carries its content and tag", () =>
    Effect.gen(function* () {
      const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const entry = yield* Entry.bytes("assets/logo.png", content)
      assert.strictEqual(entry._tag, "Bytes")
      assert.strictEqual(entry.path, "assets/logo.png")
      assert.deepStrictEqual(entry.content, content)
    })
  )

  it.effect("file carries a source location rather than content", () =>
    Effect.gen(function* () {
      const entry = yield* Entry.file("index.html", "/build/dist/index.html")
      assert.strictEqual(entry._tag, "File")
      assert.strictEqual(entry.path, "index.html")
      assert.strictEqual(entry.source, "/build/dist/index.html")
      assert.isFalse("content" in entry, "a file entry must not hold bytes")
    })
  )

  it.effect("the destination path and the source path are independent", () =>
    Effect.gen(function* () {
      const entry = yield* Entry.file("./assets//app.js", "/tmp/x/../y/app.js")
      assert.strictEqual(entry.path, "assets/app.js", "destination is normalised")
      assert.strictEqual(entry.source, "/tmp/x/../y/app.js", "source is left alone")
    })
  )
})

suite("Entry path validation", () => {
  it.effect("every constructor normalises its destination path", () =>
    Effect.gen(function* () {
      const t = yield* Entry.text("./a//b.json", "{}")
      const b = yield* Entry.bytes("./a//b.png", new Uint8Array())
      const f = yield* Entry.file("./a//b.html", "/src/b.html")
      assert.strictEqual(t.path, "a/b.json")
      assert.strictEqual(b.path, "a/b.png")
      assert.strictEqual(f.path, "a/b.html")
    })
  )

  it.effect("every constructor rejects a traversing path", () =>
    Effect.gen(function* () {
      const t = yield* Effect.flip(Entry.text("../secret.env", "x"))
      const b = yield* Effect.flip(Entry.bytes("../secret.env", new Uint8Array()))
      const f = yield* Effect.flip(Effect.asVoid(Entry.file("../secret.env", "/src/x")))
      for (const error of [t, b, f]) {
        assert.strictEqual(error._tag, "InvalidArtifactPathError")
        assert.strictEqual(error.reason, "path must not contain '..'")
      }
    })
  )

  it.effect("an absolute destination is rejected", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Entry.text("/index.html", "x"))
      assert.strictEqual(error.reason, "path must be relative")
    })
  )
})

suite("describe", () => {
  it.effect("renders each variant", () =>
    Effect.gen(function* () {
      const t = yield* Entry.text("config.json", "hello")
      const b = yield* Entry.bytes("logo.png", new Uint8Array([1, 2, 3]))
      const f = yield* Entry.file("index.html", "/build/index.html")

      assert.strictEqual(Entry.describe(t), "text config.json with 5 characters")
      assert.strictEqual(Entry.describe(b), "bytes logo.png with 3 bytes")
      assert.strictEqual(Entry.describe(f), "file index.html from /build/index.html")
    })
  )

  /**
   * Documents a known gap rather than asserting the behaviour is correct.
   * `String.length` counts UTF-16 code units, but every provider will upload
   * this as UTF-8 and count bytes. See the size decision in Artifact.
   */
  it.effect("counts UTF-16 code units for text, not encoded bytes", () =>
    Effect.gen(function* () {
      const entry = yield* Entry.text("cafe.txt", "café")
      assert.strictEqual(entry.content.length, 4)
      assert.strictEqual(new TextEncoder().encode(entry.content).length, 5)
      assert.strictEqual(Entry.describe(entry), "text cafe.txt with 4 characters")
    })
  )
})
