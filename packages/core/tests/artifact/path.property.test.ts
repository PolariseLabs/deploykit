import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { FastCheck } from "effect/testing"
import { normalise } from "../../src/artifact/path.ts"

/**
 * Example tests pin the cases someone thought of. These pin the rules that must
 * hold for every input, including the ones nobody thought of.
 */

const run = (input: string) => Effect.runSyncExit(normalise(input))

/** Path-shaped strings: far likelier to reach the interesting branches than random text. */
const noisyPath = FastCheck.array(
  FastCheck.constantFrom("a", "b.js", "dir", ".", "..", "", "x y", "sub", "..."),
  { minLength: 1, maxLength: 6 }
).chain(parts => FastCheck.constantFrom("/", "\\", "//").map(sep => parts.join(sep)))

describe("normalise invariants", () => {
  it.prop("never produces a path that would itself be rejected", [noisyPath], ([input]) => {
    const exit = run(input)
    if (Exit.isFailure(exit)) return
    const output = exit.value
    assert.isFalse(output.startsWith("/"), "no leading slash")
    assert.isFalse(output.endsWith("/"), "no trailing slash")
    assert.isFalse(output.includes("//"), "no empty segment")
    assert.isFalse(output.includes("\\"), "no backslash survives")
    assert.isFalse(output.split("/").includes(".."), "no traversal segment")
    assert.isFalse(output.split("/").includes("."), "no current-dir segment")
    assert.notStrictEqual(output, "", "no empty path")
  })

  it.prop("is idempotent: normalising the output changes nothing", [noisyPath], ([input]) => {
    const once = run(input)
    if (Exit.isFailure(once)) return
    const twice = run(once.value)
    assert.isTrue(Exit.isSuccess(twice), "a normalised path is always still valid")
    if (Exit.isSuccess(twice)) {
      assert.strictEqual(twice.value, once.value)
    }
  })

  it.prop("never invents or loses a segment", [noisyPath], ([input]) => {
    const exit = run(input)
    if (Exit.isFailure(exit)) return
    const kept = input
      .replaceAll("\\", "/")
      .split("/")
      .filter(s => s !== "" && s !== ".")
    assert.deepStrictEqual(exit.value.split("/"), kept)
  })

  /**
   * Safe means portable: no trailing dot or space, and not a Windows device
   * name. Keep this arbitrary in step with the rules in `segmentProblem`.
   */
  const safeSegment = FastCheck.stringMatching(/^[a-z0-9]([a-z0-9._-]{0,6}[a-z0-9_-])?$/).filter(
    segment => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)
  )

  it.prop(
    "accepts anything built only from safe segments",
    [FastCheck.array(safeSegment, { minLength: 1, maxLength: 5 })],
    ([parts]) => {
      const exit = run(parts.join("/"))
      assert.isTrue(Exit.isSuccess(exit), `expected ${parts.join("/")} to be accepted`)
    }
  )

  it.prop("rejects every absolute path", [noisyPath], ([input]) => {
    assert.isTrue(Exit.isFailure(run(`/${input}`)))
    assert.isTrue(Exit.isFailure(run(`\\${input}`)))
  })
})
