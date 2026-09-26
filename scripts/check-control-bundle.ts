import { build } from "esbuild"
import { Effect, Schema } from "effect"

class BundleError extends Schema.TaggedError<BundleError>()("BundleError", {
  message: Schema.String
}) {}

const program = Effect.gen(function* () {
  for (const provider of ["vercel", "cloudflare"]) {
    const result = yield* Effect.tryPromise(() =>
      build({
        entryPoints: [`packages/${provider}/dist/control.js`],
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        metafile: true,
        treeShaking: true,
        logLevel: "silent"
      })
    )
    const forbidden = Object.keys(result.metafile.inputs).filter(path =>
      /packages\/(core\/dist\/(artifact\/fromDirectory|transfer|staging)|[^/]+\/dist\/services\/(deployments|digest|streaming))\.js$/.test(
        path
      )
    )
    const external = Object.values(result.metafile.outputs)
      .flatMap(output => output.imports)
      .filter(item => item.external)
    const unresolved = result.outputFiles.some(file =>
      /\b(?:import|__require)\s*\(/.test(file.text)
    )
    if (forbidden.length > 0 || external.length > 0 || unresolved || result.warnings.length > 0) {
      return yield* new BundleError({
        message: `Unsafe ${provider} control bundle: ${JSON.stringify({ forbidden, external, unresolved, warnings: result.warnings })}`
      })
    }
    console.log(
      `${provider}: ${Object.keys(result.metafile.inputs).length} resolved modules, ${result.outputFiles[0]!.contents.length} bytes; no external imports or transfer modules`
    )
  }

  // Workers-style runtimes: nodejs_compat supplies these two, nothing else from Node.
  const allowed = ["node:crypto", "node:buffer"]
  const edge = yield* Effect.tryPromise(() =>
    build({
      entryPoints: ["packages/node/dist/edge.js"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      treeShaking: true,
      external: allowed,
      logLevel: "silent"
    })
  )
  const nodeOnly = Object.keys(edge.metafile.inputs).filter(path =>
    /@effect\/platform-node/.test(path)
  )
  const imports = Object.values(edge.metafile.outputs)
    .flatMap(output => output.imports)
    .filter(item => item.external && !allowed.includes(item.path))
  if (nodeOnly.length > 0 || imports.length > 0 || edge.warnings.length > 0) {
    return yield* new BundleError({
      message: `Unsafe edge bundle: ${JSON.stringify({ nodeOnly, imports, warnings: edge.warnings })}`
    })
  }
  console.log(
    `edge: ${Object.keys(edge.metafile.inputs).length} resolved modules, ${edge.outputFiles[0]!.contents.length} bytes; only ${allowed.join(" and ")} from Node`
  )
})

await Effect.runPromise(program)
