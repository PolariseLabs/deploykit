import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { format, resolveConfig } from "prettier"
import ts from "typescript"

class DocumentationError extends Schema.TaggedError<DocumentationError>()("DocumentationError", {
  message: Schema.String
}) {}

const Metadata = Schema.Struct({
  name: Schema.String,
  exports: Schema.Record(Schema.String, Schema.Struct({ types: Schema.String }))
})
const content = resolve("docs/content/docs")
const write = process.argv.includes("--write")
const stale: string[] = []

const update = (path: string, source: string) =>
  Effect.gen(function* () {
    const formatted = yield* Effect.tryPromise(() =>
      resolveConfig(path).then(config => format(source, { ...config, parser: "mdx" }))
    )
    const current = yield* Effect.tryPromise(() =>
      readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
    )
    if (current === formatted) return
    if (!write) {
      stale.push(relative(process.cwd(), path))
      return
    }
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, formatted)
    })
  })

const declarations = (file: string, modules: Map<string, string>): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (modules.has(file)) return
    const source = yield* Effect.tryPromise(() => readFile(file, "utf8"))
    modules.set(file, source.replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim())
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
    const references = new Set<string>()
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        references.add(node.moduleSpecifier.text)
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        references.add(node.argument.literal.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    for (const reference of references) {
      if (reference.startsWith(".")) {
        yield* declarations(
          resolve(dirname(file), reference.replace(/\.(?:js|ts)$/, ".d.ts")),
          modules
        )
      }
    }
  })

const program = Effect.gen(function* () {
  for (const name of ["core", "node", "vercel", "cloudflare", "devtools", "test"]) {
    const directory = resolve("packages", name)
    const json = yield* Effect.tryPromise(() =>
      readFile(resolve(directory, "package.json"), "utf8")
    )
    const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata))(json)
    const modules = new Map<string, string>()
    const entries = Object.entries(metadata.exports)
    for (const [, entry] of entries) yield* declarations(resolve(directory, entry.types), modules)
    const rows = entries.map(([subpath, entry]) => {
      const module = relative(resolve(directory, "dist"), resolve(directory, entry.types))
      return `| \`${metadata.name}${subpath === "." ? "" : subpath.slice(1)}\` | \`${module}\` |`
    })
    const sections = [...modules].map(([file, source]) => {
      const module = relative(resolve(directory, "dist"), file)
      return `## ${module}\n\n\`\`\`ts\n${source}\n\`\`\``
    })
    yield* update(
      resolve(content, "reference/api", `${name}.mdx`),
      `---
title: "${metadata.name}"
description: "Complete generated public declarations for ${metadata.name}."
---

This reference is generated from the built package. Start with the [guides](/docs) for working examples and the [API overview](/docs/reference) for task-oriented reference.

## Import paths

Only the import paths below are public. Supporting declaration modules describe the types reachable through those exports; their filenames are not additional public import paths.

| Import | Declaration module |
| --- | --- |
${rows.join("\n")}

${sections.join("\n\n")}
`
    )
  }
  const files = yield* Effect.tryPromise(() => readdir(content, { recursive: true }))
  for (const file of files.filter(
    file => file.endsWith(".mdx") && !file.startsWith("reference/api/")
  )) {
    const path = resolve(content, file)
    let source = yield* Effect.tryPromise(() => readFile(path, "utf8"))
    const pattern = /\{\/\* example: (examples\/docs\/[\w-]+\.ts) \*\/\}\s*```ts\n[\s\S]*?```/g
    for (const match of source.matchAll(pattern)) {
      const example = yield* Effect.tryPromise(() => readFile(resolve(match[1]!), "utf8"))
      source = source.replace(
        match[0],
        `{/* example: ${match[1]} */}\n\n\`\`\`ts\n${example.trim()}\n\`\`\``
      )
    }
    yield* update(path, source)
  }
  if (stale.length)
    return yield* new DocumentationError({ message: `Run bun run docs:sync:\n${stale.join("\n")}` })
  console.log(
    `Documentation ${write ? "synchronized" : "verified"}: six package references and checked guide examples`
  )
})

await Effect.runPromise(program)
