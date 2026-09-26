import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Artifact from "../../src/artifact/index.ts"
import * as Entry from "../../src/artifact/entry.ts"

const text = (path: string, content: string) => Entry.text(path, content)

describe("layered", () => {
  it.effect("later layers win, as a plain merge would", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "template", entries: [yield* text("config.json", "from template")] },
        { name: "generated", entries: [yield* text("config.json", "generated config")] }
      ])

      const entry = yield* Artifact.get(result.artifact, "config.json")
      assert.strictEqual(
        entry._tag === "Some" && entry.value._tag === "Text" ? entry.value.content : "",
        "generated config"
      )
    })
  )

  it.effect("records what each override replaced", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "template", entries: [yield* text("a.json", "t"), yield* text("b.js", "t")] },
        { name: "generated", entries: [yield* text("a.json", "g")] }
      ])

      assert.strictEqual(result.overrides.length, 1)
      assert.strictEqual(result.overrides[0]?.path, "a.json")
      assert.strictEqual(result.overrides[0]?.winner, "generated")
      assert.strictEqual(result.overrides[0]?.replaced, "template")
    })
  )

  it.effect("says which layer a surviving file came from", () =>
    Effect.gen(function* () {
      const overridden = yield* text("a.json", "t")
      const untouched = yield* text("b.js", "t")
      const absent = yield* text("missing.txt", "")

      const result = Artifact.layered([
        { name: "template", entries: [overridden, untouched] },
        { name: "generated", entries: [yield* text("a.json", "g")] }
      ])

      assert.strictEqual(result.layerOf(overridden.path), "generated")
      assert.strictEqual(result.layerOf(untouched.path), "template")
      assert.strictEqual(result.layerOf(absent.path), undefined)
    })
  )

  it.effect("keeps an override per displacement, not one per path", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "one", entries: [yield* text("x", "1")] },
        { name: "two", entries: [yield* text("x", "2")] },
        { name: "three", entries: [yield* text("x", "3")] }
      ])

      assert.strictEqual(result.overrides.length, 2, "two displacements happened")
      assert.deepStrictEqual(
        result.overrides.map(o => `${o.replaced}->${o.winner}`),
        ["one->two", "two->three"]
      )
    })
  )

  it.effect("reports no overrides when nothing collides", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "template", entries: [yield* text("a", "1")] },
        { name: "generated", entries: [yield* text("b", "2")] }
      ])

      assert.strictEqual(result.overrides.length, 0)
      assert.strictEqual(Artifact.fileCount(result.artifact), 2)
    })
  )
})

describe("collisions within a layer", () => {
  /**
   * The case a flat merge cannot show you. Two producers inside one layer
   * claiming the same path is nearly always a bug, and is indistinguishable
   * from a deliberate cross-layer override once everything is one array.
   */
  it.effect("are separable from deliberate overrides", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "template", entries: [yield* text("a", "t")] },
        {
          name: "assets",
          entries: [
            yield* text("a", "user upload shadowing the template"),
            yield* text("b", "one"),
            yield* text("b", "two producers, one path")
          ]
        }
      ])

      assert.strictEqual(result.overrides.length, 2, "both displacements recorded")

      const withinLayer = Artifact.collisionsWithinLayers(result)
      assert.strictEqual(withinLayer.length, 1)
      assert.strictEqual(withinLayer[0]?.path, "b")
      assert.strictEqual(withinLayer[0]?.winner, "assets")
      assert.strictEqual(withinLayer[0]?.replaced, "assets")
    })
  )

  it.effect("is empty when every override crossed a layer boundary", () =>
    Effect.gen(function* () {
      const result = Artifact.layered([
        { name: "template", entries: [yield* text("a", "t")] },
        { name: "assets", entries: [yield* text("a", "u")] }
      ])

      assert.strictEqual(Artifact.collisionsWithinLayers(result).length, 0)
    })
  )
})

describe("summarise", () => {
  it.effect("counts what each layer contributed and what survived", () =>
    Effect.gen(function* () {
      const layers = [
        {
          name: "template",
          entries: [yield* text("a", "t"), yield* text("b", "t"), yield* text("c", "t")]
        },
        { name: "generated", entries: [yield* text("a", "g")] }
      ]

      const summary = Artifact.summarise(layers, Artifact.layered(layers))

      assert.deepStrictEqual(summary, [
        { name: "template", contributed: 3, surviving: 2 },
        { name: "generated", contributed: 1, surviving: 1 }
      ])
    })
  )

  it.effect("reports a layer entirely displaced", () =>
    Effect.gen(function* () {
      const layers = [
        { name: "template", entries: [yield* text("a", "t")] },
        { name: "generated", entries: [yield* text("a", "g")] }
      ]

      const summary = Artifact.summarise(layers, Artifact.layered(layers))

      assert.strictEqual(summary[0]?.surviving, 0, "contributed one, kept none")
      assert.strictEqual(summary[0]?.contributed, 1)
    })
  )
})
