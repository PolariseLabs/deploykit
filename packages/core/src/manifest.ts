import { utf8Length } from "./artifact/pathRules.js"
import { Effect, Schema } from "effect"
import { normalise } from "./artifact/path.js"
import { make } from "./artifact/artifact.js"
import type { SourceEntry } from "./artifact/entry.js"
import type { FileSource } from "./source.js"
import { ValidationError } from "./provider/errors.js"

export const Fingerprint = Schema.Struct({
  recipe: Schema.String,
  context: Schema.String,
  value: Schema.String
})
export const ManifestEntry = Schema.Struct({
  path: Schema.String,
  byteLength: Schema.Number,
  source: Schema.String,
  sha256: Schema.String,
  fingerprints: Schema.optional(Schema.Array(Fingerprint))
})
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(ManifestEntry)
})
export type Manifest = typeof Manifest.Type

/** Validates and canonicalizes untrusted data before attaching any source. */
export const decode = (input: unknown) =>
  Effect.gen(function* () {
    const manifest = yield* Schema.decodeUnknownEffect(Manifest)(input).pipe(
      Effect.mapError(() => new ValidationError({ message: "Invalid manifest structure" }))
    )
    if (manifest.entries.length > 20000)
      return yield* new ValidationError({ message: "Manifest exceeds 20000 entries" })
    const paths = new Set<string>()
    const entries = yield* Effect.forEach(manifest.entries, entry =>
      Effect.gen(function* () {
        const path = yield* normalise(entry.path).pipe(
          Effect.mapError(() => new ValidationError({ message: "Unsafe destination path" }))
        )
        if (paths.has(path))
          return yield* new ValidationError({ message: `Duplicate destination: ${path}` })
        paths.add(path)
        if (
          !Number.isSafeInteger(entry.byteLength) ||
          entry.byteLength < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !/^[\w./:-]{1,512}$/.test(entry.source) ||
          entry.source.includes("://")
        ) {
          return yield* new ValidationError({ message: `Invalid source metadata: ${path}` })
        }
        if ((entry.fingerprints?.length ?? 0) > 16)
          return yield* new ValidationError({ message: "Too many fingerprints" })
        const recipes = new Set<string>()
        for (const fingerprint of entry.fingerprints ?? []) {
          if (
            !/^[\w.-]{1,80}$/.test(fingerprint.recipe) ||
            fingerprint.context.length > 1024 ||
            !/^[a-f0-9]{1,128}$/.test(fingerprint.value) ||
            recipes.has(fingerprint.recipe)
          ) {
            return yield* new ValidationError({ message: `Invalid fingerprint: ${path}` })
          }
          recipes.add(fingerprint.recipe)
        }
        return {
          path,
          byteLength: entry.byteLength,
          source: entry.source,
          sha256: entry.sha256,
          ...((entry.fingerprints?.length ?? 0) === 0
            ? {}
            : {
                fingerprints: (entry.fingerprints ?? [])
                  .map(fingerprint => ({
                    recipe: fingerprint.recipe,
                    context: fingerprint.context,
                    value: fingerprint.value
                  }))
                  .sort((a, b) => (a.recipe < b.recipe ? -1 : a.recipe > b.recipe ? 1 : 0))
              })
        }
      })
    )
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (const entry of entries) {
      const parts = entry.path.split("/")
      for (let index = 1; index < parts.length; index++) {
        if (paths.has(parts.slice(0, index).join("/")))
          return yield* new ValidationError({ message: "File and directory destinations collide" })
      }
    }
    return { version: 1 as const, entries }
  })

/** Envelope identity includes source references and cached fingerprint metadata. */
export const encode = (input: unknown) =>
  decode(input).pipe(
    Effect.flatMap(value => {
      const json = JSON.stringify(value)
      return utf8Length(json) > 16 * 1024 * 1024
        ? Effect.fail(new ValidationError({ message: "Manifest JSON exceeds 16 MiB" }))
        : Effect.succeed(json)
    })
  )
export const fromJson = (json: string) =>
  utf8Length(json) > 16 * 1024 * 1024
    ? Effect.fail(new ValidationError({ message: "Manifest JSON exceeds 16 MiB" }))
    : Effect.try({
        try: (): unknown => JSON.parse(json),
        catch: () => new ValidationError({ message: "Invalid manifest JSON" })
      }).pipe(Effect.flatMap(decode))

export const toArtifact = (input: unknown, source: FileSource) =>
  decode(input).pipe(
    Effect.flatMap(manifest =>
      make(
        manifest.entries.map((entry): SourceEntry => ({
          _tag: "Source",
          path: entry.path,
          byteLength: entry.byteLength,
          sha256: entry.sha256,
          fingerprints: entry.fingerprints ?? [],
          open: () => source.open(entry.source)
        }))
      )
    )
  )
