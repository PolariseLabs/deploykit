import { createHash } from "node:crypto"
import { Cause, Effect, Exit, FileSystem, Layer, Schedule, Schema, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Entry, Platform, Provider } from "@deploykit/core"
import { vercelLayer } from "@deploykit/vercel"
import { cloudflareLayer } from "@deploykit/cloudflare"

const STATIC_PREFIX = ".vercel/output/static"

/** PROVIDER=cloudflare swaps the layer and nothing else. */
const target: "vercel" | "cloudflare" =
  process.env["PROVIDER"] === "cloudflare" ? "cloudflare" : "vercel"

/** Tagged, so it stays distinguishable from a provider failure in the channel. */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String
}) {}

/** The deployment said READY but the URL did not serve what we uploaded. */
class NotServing extends Schema.TaggedError<NotServing>()("NotServing", {
  url: Schema.String,
  status: Schema.Number,
  detail: Schema.String
}) {}

const buildOutput = (directory: string, provider: "vercel" | "cloudflare") =>
  Effect.gen(function* () {
    const source = yield* Artifact.fromDirectory(directory)
    const prefix = provider === "vercel" ? `${STATIC_PREFIX}/` : ""

    const staticFiles = yield* Effect.forEach(Artifact.list(source), entry =>
      Entry.file(`${prefix}${entry.path}`, `${directory}/${entry.path}`)
    )

    const fn = ".vercel/output/functions/hello.func"
    const functionFiles =
      provider === "vercel"
        ? [
            yield* Entry.text(
              `${fn}/.vc-config.json`,
              JSON.stringify({
                runtime: "nodejs22.x",
                handler: "index.js",
                launcherType: "Nodejs"
              })
            ),
            yield* Entry.text(
              `${fn}/index.js`,
              "module.exports = (req, res) => { res.setHeader('content-type','text/plain'); res.end('deploykit') }"
            ),
            yield* Entry.text(`${fn}/package.json`, JSON.stringify({ type: "commonjs" }))
          ]
        : []

    const generated =
      provider === "vercel"
        ? [
            yield* Entry.text(
              ".vercel/output/config.json",
              JSON.stringify({ version: 3, routes: [{ src: "/api/hello", dest: "/hello" }] })
            )
          ]
        : []

    const layers = [
      { name: "template", entries: staticFiles },
      { name: "functions", entries: functionFiles },
      { name: "generated", entries: generated }
    ]
    const composed = Artifact.layered(layers)

    for (const summary of Artifact.summarise(layers, composed)) {
      yield* Effect.log(
        `layer ${summary.name}: ${summary.contributed} files, ${summary.surviving} surviving`
      )
    }
    for (const override of composed.overrides) {
      yield* Effect.log(`override ${override.path}: ${override.replaced} -> ${override.winner}`)
    }

    return composed.artifact
  })

const verifyServing = (url: string, expectedIndex: string) =>
  Effect.gen(function* () {
    const started = Date.now()

    const status = yield* Platform.waitUntilServing(url, {
      schedule: Schedule.spaced("3 seconds").pipe(Schedule.upTo({ duration: "3 minutes" }))
    }).pipe(
      Effect.mapError(
        failure =>
          new NotServing({
            url,
            status: failure.status ?? 0,
            detail: `never served, waited ${Math.round(failure.waitedMs / 1000)}s`
          })
      )
    )

    const body = yield* Effect.promise(() =>
      fetch(url, { redirect: "manual" }).then(response => response.text())
    )
    const waited = ((Date.now() - started) / 1000).toFixed(1)

    if (body !== expectedIndex) {
      return yield* new NotServing({
        url,
        status,
        detail: `served ${body.length} chars but we uploaded ${expectedIndex.length}. First 200: ${body.slice(0, 200)}`
      })
    }

    yield* Effect.log(
      `serving: HTTP ${status} after ${waited}s, ${body.length} chars, identical to the file we uploaded`
    )
  })

const verifyAsset = (url: string, assetPath: string, sourcePath: string) =>
  Effect.gen(function* () {
    const href = `${url}/${assetPath}`
    const response = yield* Effect.promise(() => fetch(href, { redirect: "manual" }))
    if (!response.ok) {
      return yield* new NotServing({
        url: href,
        status: response.status,
        detail: "a nested asset did not serve, so the output layout is wrong"
      })
    }
    const fs = yield* FileSystem.FileSystem
    const expected = createHash("sha256")
    const actual = createHash("sha256")
    yield* fs.stream(sourcePath).pipe(
      Stream.runForEach(bytes =>
        Effect.sync(() => {
          expected.update(bytes)
        })
      )
    )
    if (response.body === null)
      return yield* new NotServing({
        url: href,
        status: response.status,
        detail: "Missing asset body"
      })
    yield* Stream.fromReadableStream({
      evaluate: () => response.body!,
      onError: () =>
        new NotServing({ url: href, status: response.status, detail: "Asset stream failed" })
    }).pipe(
      Stream.runForEach(bytes =>
        Effect.sync(() => {
          actual.update(bytes)
        })
      )
    )
    if (actual.digest("hex") !== expected.digest("hex"))
      return yield* new NotServing({
        url: href,
        status: response.status,
        detail: "Asset SHA-256 mismatch"
      })
    yield* Effect.log(`serving: ${assetPath} HTTP ${response.status}, SHA-256 matches`)
  })

const verifyFunction = (url: string) =>
  Effect.gen(function* () {
    const href = `${url}/api/hello`
    const response = yield* Effect.promise(() => fetch(href, { redirect: "manual" }))
    const body = yield* Effect.promise(() => response.text().catch(() => ""))

    if (!response.ok || body.trim() !== "deploykit") {
      return yield* new NotServing({
        url: href,
        status: response.status,
        detail: `serverless function did not answer as expected: ${body.slice(0, 200)}`
      })
    }
    yield* Effect.log(`serving: /api/hello HTTP ${response.status}, function answered`)
  })

const program = Effect.gen(function* () {
  if (
    process.env["DEPLOYKIT_ISOLATED"] !== "1" ||
    !["0", "1"].includes(process.env["CLEANUP"] ?? "")
  )
    return yield* new UsageError({
      message:
        "Designate an isolated account and set DEPLOYKIT_ISOLATED=1; choose CLEANUP=1 or explicitly keep the project with CLEANUP=0"
    })
  const directory = process.argv[2]
  if (directory === undefined) {
    return yield* new UsageError({
      message: "usage: bun run smoke <directory> [project-name]"
    })
  }
  // Pages names are lowercase alphanumerics and hyphens, and short.
  const name = process.argv[3] ?? `deploykit-smoke-${Date.now().toString(36)}`

  if (!name.startsWith("deploykit-smoke-"))
    return yield* new UsageError({ message: "Test project names must start with deploykit-smoke-" })

  const provider = yield* Provider.DeploymentProvider
  yield* Effect.log(`provider: ${provider.name}`)

  const fs = yield* FileSystem.FileSystem
  const expectedIndex = yield* fs.readFileString(`${directory}/index.html`)

  const artifact = yield* buildOutput(directory, target)
  const assets = Artifact.list(artifact).filter(
    entry => entry._tag === "File" && entry.path.includes("assets/")
  )
  const bytes = Artifact.totalSize(artifact)
  yield* Effect.log(`artifact: ${Artifact.fileCount(artifact)} files, ${bytes} bytes`)

  const app = yield* provider.createApp(name)
  yield* Effect.log(`created project ${app.name} (${app.id})`)

  return yield* Effect.acquireUseRelease(
    Effect.succeed(app),
    app =>
      Effect.gen(function* () {
        if (provider.setAccess === undefined) {
          yield* Effect.log("access: this provider has no access model, skipping")
        } else {
          yield* provider.setAccess(app.id, { _tag: "Public" })
          const modes = [...Provider.capabilitiesOf(provider).accessModes].join(", ")
          yield* Effect.log(`access: public (provider supports: ${modes})`)
        }
        const started = yield* provider.deploy(app.id, artifact)
        yield* Effect.log(`deployment ${started.id} is ${started.status}`)

        const settled = yield* provider.getDeployment(app.id, started.id).pipe(
          Effect.tap(d => Effect.log(`  ${d.status}${d.url === undefined ? "" : ` ${d.url}`}`)),
          Effect.repeat({
            until: d => Provider.isTerminal(d.status),
            schedule: Schedule.spaced("3 seconds").pipe(Schedule.upTo({ duration: "5 minutes" }))
          })
        )

        yield* Effect.log(`finished: ${settled.status} ${settled.url ?? "(no url)"}`)
        if (settled.reason !== undefined) yield* Effect.log(`reason: ${settled.reason}`)

        if (settled.status === "deployed" && settled.url !== undefined) {
          yield* verifyServing(settled.url, expectedIndex)
          for (const asset of assets) {
            if (asset._tag !== "File") continue
            const path =
              target === "vercel" ? asset.path.slice(STATIC_PREFIX.length + 1) : asset.path
            yield* verifyAsset(settled.url, path, asset.source)
          }
          if (target === "vercel") yield* verifyFunction(settled.url)
        } else {
          return yield* new NotServing({
            url: settled.url ?? "",
            status: 0,
            detail: `Deployment did not become ready: ${settled.status}`
          })
        }
        return settled
      }),
    app =>
      process.env["CLEANUP"] === "0"
        ? Effect.log(`kept project ${app.name} (${app.id}) for inspection`)
        : provider.deleteApp(app.id).pipe(
            Effect.tap(() => Effect.log(`deleted project ${app.id}`)),
            Effect.tapError(() =>
              Effect.logError(`Cleanup failed; remove temporary project ${app.id}`)
            ),
            Effect.orDie
          )
  )
})

const runtime = (target === "cloudflare" ? cloudflareLayer : vercelLayer).pipe(
  Layer.provideMerge(NodeFileSystem.layer)
)

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(runtime)))

if (Exit.isFailure(exit)) {
  for (const reason of exit.cause.reasons.filter(Cause.isFailReason)) {
    const error = reason.error
    if (error instanceof NotServing) {
      console.error(`NotServing ${error.url}`)
      console.error(`  status: ${error.status}`)
      console.error(`  ${error.detail}`)
    } else if (error instanceof UsageError) {
      console.error(error.message)
    } else {
      console.error(error)
    }
  }
  if (exit.cause.reasons.some(reason => !Cause.isFailReason(reason)))
    console.error(Cause.pretty(exit.cause))
  process.exit(1)
}
