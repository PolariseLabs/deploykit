import { Schema, Effect, Match } from "effect"
import { normalise, ArtifactPathSchema } from "./path.js"

export class TextEntry extends Schema.TaggedClass<TextEntry>()("Text", {
  path: ArtifactPathSchema,
  content: Schema.String
}) {}

export class BytesEntry extends Schema.TaggedClass<BytesEntry>()("Bytes", {
  path: ArtifactPathSchema,
  content: Schema.Uint8Array
}) {}

export class FileEntry extends Schema.TaggedClass<FileEntry>()("File", {
  path: ArtifactPathSchema,
  source: Schema.String
}) {}

export const EntrySchema = Schema.Union([TextEntry, BytesEntry, FileEntry])
export type Entry = typeof EntrySchema.Type

export const text = (path: string, content: string) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new TextEntry({ path: NormalPath, content })
  })
}

export const bytes = (path: string, content: Uint8Array) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new BytesEntry({ path: NormalPath, content })
  })
}

export const file = (path: string, source: string) => {
  return Effect.gen(function* () {
    const NormalPath = yield* normalise(path)
    return new FileEntry({ path: NormalPath, source })
  })
}

export const describe = (entry: Entry) => {
  return Match.valueTags(entry, {
    Text: ({ path, content }) => `text ${path} with ${content.length} characters`,
    Bytes: ({ path, content }) => `bytes ${path} with ${content.length} bytes`,
    File: ({ path, source }) => `file ${path} from ${source}`
  })
}
