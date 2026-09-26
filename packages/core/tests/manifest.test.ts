import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Manifest } from "@deploykit/core"

const entry = (path: string) => ({
  path,
  byteLength: 0,
  source: "blob:one",
  sha256: "0".repeat(64)
})
it.effect("canonical manifests are independent of entry and fingerprint order", () =>
  Effect.gen(function* () {
    const a = yield* Manifest.encode({ version: 1, entries: [entry("z"), entry("a")] })
    const b = yield* Manifest.encode({ version: 1, entries: [entry("a"), entry("z")] })
    assert.strictEqual(a, b)
    const artifact = yield* Manifest.toArtifact(yield* Manifest.fromJson(a), {
      open: () => Stream.empty
    })
    assert.deepStrictEqual([...artifact.entries.keys()], ["a", "z"])
  })
)
it.effect("rejects unsafe paths, collisions and malformed metadata", () =>
  Effect.gen(function* () {
    for (const entries of [
      [entry("../x")],
      [entry("x"), entry("./x")],
      [entry("x"), entry("x/y")],
      [{ ...entry("x"), byteLength: -1 }],
      [{ ...entry("x"), sha256: "bad" }],
      [{ ...entry("x"), source: "https://signed.test" }]
    ]) {
      const error = yield* Effect.flip(Manifest.decode({ version: 1, entries }))
      assert.strictEqual(error._tag, "ValidationError")
    }
  })
)

it.effect("canonical fingerprint fields ignore object insertion order", () =>
  Effect.gen(function* () {
    const a = {
      version: 1,
      entries: [{ ...entry("x"), fingerprints: [{ value: "abcd", context: "", recipe: "r1" }] }]
    }
    const b = {
      version: 1,
      entries: [{ ...entry("x"), fingerprints: [{ recipe: "r1", context: "", value: "abcd" }] }]
    }
    assert.strictEqual(yield* Manifest.encode(a), yield* Manifest.encode(b))
  })
)
