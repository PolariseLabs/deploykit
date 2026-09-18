import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Artifact from "../../src/artifact/artifact.ts"
import * as Entry from "../../src/artifact/entry.ts"

const index = Entry.fileWithSize("index.html", "/dist/index.html", 10)
const app = Entry.fileWithSize("assets/app.js", "/dist/assets/app.js", 20)
const config = Entry.text("config.json", '{"brand":"acme"}')

describe("empty", () => {
  it("holds nothing", () => {
    assert.strictEqual(Artifact.fileCount(Artifact.empty), 0)
    assert.deepStrictEqual(Artifact.list(Artifact.empty), [])
  })
})

describe("add", () => {
  it.effect("returns a new artifact containing the entry", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      assert.strictEqual(Artifact.fileCount(artifact), 1)
      assert.isTrue(yield* Artifact.has(artifact, "config.json"))
    })
  )

  it.effect("does not mutate the artifact it was given", () =>
    Effect.gen(function* () {
      const before = yield* Artifact.add(Artifact.empty, yield* index)
      const after = yield* Artifact.add(before, yield* config)
      assert.strictEqual(Artifact.fileCount(before), 1, "the original is untouched")
      assert.strictEqual(Artifact.fileCount(after), 2)
    })
  )

  /**
   * The reason `add` copies rather than mutates: one base artifact must be
   * reusable across tenants without their config bleeding into each other.
   */
  it.effect("keeps two artifacts built from one base independent", () =>
    Effect.gen(function* () {
      const base = yield* Artifact.make([yield* index, yield* app])

      const acme = yield* Artifact.add(base, yield* Entry.text("config.json", "acme"))
      const globex = yield* Artifact.add(base, yield* Entry.text("config.json", "globex"))

      assert.strictEqual(Artifact.fileCount(base), 2, "base is never polluted")

      const acmeConfig = yield* Artifact.get(acme, "config.json")
      const globexConfig = yield* Artifact.get(globex, "config.json")
      assert.deepStrictEqual(
        Option.map(acmeConfig, e => (e._tag === "Text" ? e.content : "")),
        Option.some("acme")
      )
      assert.deepStrictEqual(
        Option.map(globexConfig, e => (e._tag === "Text" ? e.content : "")),
        Option.some("globex")
      )
    })
  )

  it.effect("rejects a second entry at the same path", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      const error = yield* Effect.flip(Artifact.add(artifact, yield* config))
      assert.strictEqual(error._tag, "DuplicatePathError")
      assert.strictEqual(error.path, "config.json")
    })
  )

  it.effect("detects a duplicate that only collides after normalisation", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      const clash = yield* Entry.text("./config.json", "other")
      const error = yield* Effect.flip(Artifact.add(artifact, clash))
      assert.strictEqual(error._tag, "DuplicatePathError")
    })
  )
})

describe("has", () => {
  it.effect("answers true and false rather than failing on absence", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      assert.isTrue(yield* Artifact.has(artifact, "config.json"))
      assert.isFalse(yield* Artifact.has(artifact, "missing.txt"))
    })
  )

  it.effect("normalises the path it is asked about", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      assert.isTrue(yield* Artifact.has(artifact, "./config.json"))
    })
  )

  it.effect("fails on a malformed path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Artifact.has(Artifact.empty, "../evil"))
      assert.strictEqual(error._tag, "InvalidArtifactPathError")
    })
  )
})

describe("get", () => {
  it.effect("returns Some for a present entry", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.add(Artifact.empty, yield* config)
      const found = yield* Artifact.get(artifact, "./config.json")
      assert.isTrue(Option.isSome(found))
    })
  )

  it.effect("returns None for an absent entry, without failing", () =>
    Effect.gen(function* () {
      const found = yield* Artifact.get(Artifact.empty, "nope.txt")
      assert.isTrue(Option.isNone(found))
    })
  )

  it.effect("keeps a malformed path in the error channel, not the Option", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Artifact.get(Artifact.empty, "/absolute.txt"))
      assert.strictEqual(error._tag, "InvalidArtifactPathError")
      assert.strictEqual(error.reason, "path must be relative")
    })
  )
})

describe("make", () => {
  /**
   * Adapters hash and upload entries in iteration order, so the same inputs must
   * always produce the same order. Insertion order, never sorted.
   */
  it.effect("preserves insertion order", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.make([
        yield* Entry.fileWithSize("b.html", "/d/b.html", 1),
        yield* Entry.fileWithSize("a.html", "/d/a.html", 1),
        yield* Entry.text("c.json", "{}")
      ])
      assert.deepStrictEqual(
        Artifact.list(artifact).map(e => e.path),
        ["b.html", "a.html", "c.json"]
      )
    })
  )

  it.effect("accepts an empty list", () =>
    Effect.gen(function* () {
      assert.strictEqual(Artifact.fileCount(yield* Artifact.make([])), 0)
    })
  )

  it.effect("fails on the first duplicate", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Artifact.make([
          yield* Entry.text("a.json", "1"),
          yield* Entry.text("b.json", "2"),
          yield* Entry.text("a.json", "3")
        ])
      )
      assert.strictEqual(error._tag, "DuplicatePathError")
      assert.strictEqual(error.path, "a.json")
    })
  )
})

describe("fileCount", () => {
  it.effect("counts entries", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.make([yield* index, yield* app, yield* config])
      assert.strictEqual(Artifact.fileCount(artifact), 3)
      assert.strictEqual(Artifact.fileCount(artifact), Artifact.list(artifact).length)
    })
  )
})
