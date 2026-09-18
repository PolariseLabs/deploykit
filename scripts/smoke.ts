/**
 * A throwaway end-to-end check against a real Vercel account.
 *
 * Everything else in this repo is tested against stubs, which can prove what
 * deploykit sends but never that Vercel accepts it. This does one real round
 * trip: create a project, deploy a directory as a prebuilt Build Output tree,
 * poll until it settles, print the URL, then delete the project again.
 *
 *   bun run smoke <directory> [project-name]
 *   CLEANUP=1 bun run smoke <directory>      # delete the project afterwards
 *
 * The project is KEPT by default so you can open the URL and inspect it.
 *
 * Reads VERCEL_TOKEN, falling back to VERCEL_API_KEY, and VERCEL_TEAM_ID when
 * the token is not already scoped to a team.
 *
 * With CLEANUP=1 the project is deleted afterwards, including when the deploy
 * fails, so a CI run does not litter the account.
 */

import { Cause, Effect, Exit, FileSystem, Layer, Schedule, Schema } from "effect"
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

/**
 * A Build Output tree: every served file under `static/`, plus the config that
 * tells Vercel this is version 3 output. the consumer's template usually carries a
 * config; when it does not, its injector synthesises exactly this.
 */
/**
 * The one thing that is NOT portable.
 *
 * An Artifact is a map of paths to bytes, and that travels. The layout does
 * not: Vercel wants a Build Output tree with everything under
 * `.vercel/output/static` and a `config.json` declaring version 3, while
 * Pages takes the files at the root and has no such file. deploykit deploys
 * whatever tree you give it; deciding what the tree looks like is the
 * caller's job, and it is provider-specific.
 */
const buildOutput = (directory: string, provider: "vercel" | "cloudflare") =>
  Effect.gen(function* () {
    const source = yield* Artifact.fromDirectory(directory)
    const prefix = provider === "vercel" ? `${STATIC_PREFIX}/` : ""

    const staticFiles = yield* Effect.forEach(Artifact.list(source), entry =>
      Entry.file(`${prefix}${entry.path}`, `${directory}/${entry.path}`)
    )

    /**
     * A serverless function, Vercel only for now. Pages Functions use a
     * `_worker.js` or a `functions/` directory, which is a different shape
     * again, so proving one says nothing about the other.
     */
    const fn = ".vercel/output/functions/hello.func"
    const functionFiles =
      provider === "vercel"
        ? [
            yield* Entry.text(
              `${fn}/.vc-config.json`,
              JSON.stringify({
                runtime: "nodejs20.x",
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

/**
 * Fetch the deployed URL and confirm it serves what we uploaded.
 *
 * READY means Vercel finished, not that the site answers. The first version of
 * this check asserted "HTTP 200 and the body contains <html>" and passed while
 * actually receiving 340 KB of Vercel's own login page, because it followed a
 * redirect. So: do not follow redirects, and compare against the bytes we
 * uploaded rather than against a shape.
 */
const verifyServing = (url: string, expectedIndex: string) =>
  Effect.gen(function* () {
    const started = Date.now()

    /**
     * Core's waitUntilServing, not a hand-rolled loop.
     *
     * The loop this replaces died on Cloudflare: a fresh pages.dev subdomain
     * does not resolve for the better part of a minute, so fetch THROWS
     * rather than answering 404, and a bare Effect.promise turns that into a
     * defect. waitUntilServing already treats no-answer as worth waiting for,
     * which is the whole reason it exists.
     */
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

/**
 * A hashed asset, to prove nested paths under static/ resolve too. index.html
 * alone would pass even if every subdirectory were mis-placed.
 */
const verifyAsset = (url: string, assetPath: string) =>
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
    yield* Effect.log(`serving: ${assetPath} HTTP ${response.status}`)
  })

/**
 * A serverless function is a different code path on Vercel's side from a
 * static file, so it needs its own evidence.
 */
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
  const directory = process.argv[2]
  if (directory === undefined) {
    return yield* new UsageError({
      message: "usage: bun run smoke <directory> [project-name]"
    })
  }
  // Pages names are lowercase alphanumerics and hyphens, and short.
  const name = process.argv[3] ?? `deploykit-smoke-${Date.now().toString(36)}`

  const provider = yield* Provider.DeploymentProvider
  yield* Effect.log(`provider: ${provider.name}`)

  const fs = yield* FileSystem.FileSystem
  const expectedIndex = yield* fs.readFileString(`${directory}/index.html`)

  const artifact = yield* buildOutput(directory, target)
  // Any nested file will do; the point is that a subdirectory resolves at all.
  const firstAsset = Artifact.list(artifact)
    .map(entry => entry.path)
    .filter(path => path.startsWith(`${STATIC_PREFIX}/`) && path.includes("/assets/"))
    .map(path => path.slice(STATIC_PREFIX.length + 1))[0]
  const bytes = Artifact.totalSize(artifact)
  yield* Effect.log(`artifact: ${Artifact.fileCount(artifact)} files, ${bytes} bytes`)

  const app = yield* provider.createApp(name)
  yield* Effect.log(`created project ${app.name} (${app.id})`)

  // A team with deployment protection on by default makes every new project
  // unreachable, so the serving check would only ever see Vercel's login page.
  // Through the portable contract, not the Vercel client: if this is a real
  // capability it should be reachable without dropping to the adapter.
  if (provider.setAccess === undefined) {
    yield* Effect.log("access: this provider has no access model, skipping")
  } else {
    yield* provider.setAccess(app.id, { _tag: "Public" })
    const modes = [...Provider.capabilitiesOf(provider).accessModes].join(", ")
    yield* Effect.log(`access: public (provider supports: ${modes})`)
  }

  // Deleting even on failure: a half-finished smoke run should not leave a
  // project behind, and this is the same compensation shape Platform uses.
  return yield* Effect.acquireUseRelease(
    Effect.succeed(app),
    app =>
      Effect.gen(function* () {
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
          if (firstAsset !== undefined) yield* verifyAsset(settled.url, firstAsset)
          if (target === "vercel") yield* verifyFunction(settled.url)
        }
        return settled
      }),
    app =>
      // Kept by default: during bring-up you want to click the URL and look at
      // the deployment. CLEANUP=1 removes it, which is what CI would pass.
      process.env["CLEANUP"] !== "1"
        ? Effect.log(
            `project ${app.id} left in place. Remove it with CLEANUP=1, or in the dashboard.`
          )
        : provider.deleteApp(app.id).pipe(
            Effect.tap(() => Effect.log(`deleted project ${app.id}`)),
            // Cleanup failing must not hide why the deploy failed.
            Effect.catchCause(cause => Effect.log(`cleanup failed: ${Cause.pretty(cause)}`))
          )
  )
})

/**
 * The whole point, in one expression: the program above names no provider.
 * Swapping this layer is the only difference between deploying to Vercel and
 * deploying to Cloudflare Pages.
 *
 * provideMerge, not provide: the program itself reads the directory, so it
 * needs FileSystem too, not only the adapter underneath it.
 */
const runtime = (target === "cloudflare" ? cloudflareLayer : vercelLayer).pipe(
  Layer.provideMerge(NodeFileSystem.layer)
)

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(runtime)))

if (Exit.isFailure(exit)) {
  // Cause.pretty prints a tagged error's name and nothing else, so the fields
  // that say what went wrong are spelled out here. A failure whose message is
  // just its own tag is no better than a silent one.
  for (const reason of exit.cause.reasons.filter(Cause.isFailReason)) {
    const error = reason.error
    if (error instanceof NotServing) {
      console.error(`NotServing ${error.url}`)
      console.error(`  status: ${error.status}`)
      console.error(`  ${error.detail}`)
    } else if (error instanceof UsageError) {
      console.error(error.message)
    } else {
      console.error(Cause.pretty(exit.cause))
    }
  }
  process.exit(1)
}
