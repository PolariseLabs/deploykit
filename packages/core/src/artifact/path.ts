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
