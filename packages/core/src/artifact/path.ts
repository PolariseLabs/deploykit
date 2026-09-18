import { Schema, Effect } from "effect"
import { DRIVE_LETTER, MAX_PATH_BYTES, segmentProblem, utf8Length } from "./pathRules.js"

export const ArtifactPathSchema = Schema.String.pipe(Schema.brand("ArtifactPath"))
export type ArtifactPath = typeof ArtifactPathSchema.Type

export class InvalidArtifactPathError extends Schema.TaggedError<InvalidArtifactPathError>()(
  "InvalidArtifactPathError",
  {
    path: Schema.String,
    reason: Schema.String
  }
) {}

/**
 * Turns caller input into a destination path that is portable across operating
 * systems and providers. Cosmetic noise is repaired because it cannot change
 * which file was meant; anything ambiguous or unportable is rejected.
 */
export const normalise = (input: string): Effect.Effect<ArtifactPath, InvalidArtifactPathError> => {
  return Effect.gen(function* () {
    const fail = (reason: string) => new InvalidArtifactPathError({ path: input, reason })

    const trimmed = input.trim()
    if (trimmed === "") {
      return yield* fail("path is empty")
    }

    // NFC first: macOS hands back decomposed names, so the same file from two
    // machines must collide in duplicate detection rather than deploy twice.
    const canonical = trimmed.normalize("NFC")
    if (utf8Length(canonical) > MAX_PATH_BYTES) {
      return yield* fail(`path must be at most ${MAX_PATH_BYTES} bytes`)
    }

    // Backslashes first, so "\\server\share" and "C:\dist" reach the checks below.
    const slashed = canonical.replace(/\\/g, "/")
    if (slashed.startsWith("/")) {
      return yield* fail("path must be relative")
    }
    if (slashed.endsWith("/")) {
      return yield* fail("path must not end with a slash")
    }
    if (DRIVE_LETTER.test(slashed)) {
      return yield* fail("path must not start with a drive letter")
    }

    const segments = slashed.split("/").filter(segment => segment !== "" && segment !== ".")
    if (segments.includes("..")) {
      return yield* fail("path must not contain '..'")
    }
    if (segments.length === 0) {
      return yield* fail("path has no segments")
    }

    for (const segment of segments) {
      const problem = segmentProblem(segment)
      if (problem !== undefined) {
        return yield* fail(problem)
      }
    }

    return ArtifactPathSchema.make(segments.join("/"))
  })
}

export interface ExactOptions {
  /**
   * Require the path to sit under this prefix, itself given canonically.
   * A deploy tree usually has a root (`.vercel/output` for Vercel), and a file
   * outside it is a producer mistake rather than something to relocate.
   */
  readonly root?: string
}

/**
 * Accept a path only if it is already exactly what will be written.
 *
 * `normalise` repairs: it trims, applies NFC, rewrites backslashes and drops
 * `.` and empty segments. That is convenient when the path and the thing that
 * refers to it are produced together, and dangerous when they are not. A
 * config that says `./assets/x.png` while the file is written as
 * `assets/x.png` resolves against the current route and 404s, and the repair
 * is what hid the mismatch.
 *
 * So this rejects instead, for producers that compute references separately
 * and need the path they asked for to be the path they get. Same rules, no
 * silent fixes: the producer should emit the path it means.
 *
 * Use `normalise` for input a human typed. Use this for a path some other part
 * of your system is going to point at.
 */
export const exact = (
  input: string,
  options: ExactOptions = {}
): Effect.Effect<ArtifactPath, InvalidArtifactPathError> =>
  Effect.gen(function* () {
    const repaired = yield* normalise(input)

    if (repaired !== input) {
      return yield* new InvalidArtifactPathError({
        path: input,
        reason: `path is not canonical: it would be written as "${repaired}"`
      })
    }

    if (options.root !== undefined) {
      const root = options.root.endsWith("/") ? options.root : `${options.root}/`
      if (!repaired.startsWith(root)) {
        return yield* new InvalidArtifactPathError({
          path: input,
          reason: `path must sit under "${root}"`
        })
      }
    }

    return repaired
  })
