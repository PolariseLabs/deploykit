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
import { Artifact, Entry, Provider } from "@deploykit/core"
import { vercelLayer } from "@deploykit/vercel"

const STATIC_PREFIX = ".vercel/output/static"

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
const buildOutput = (directory: string) =>
  Effect.gen(function* () {
    const source = yield* Artifact.fromDirectory(directory)

    const staticFiles = yield* Effect.forEach(Artifact.list(source), entry =>
      Entry.file(`${STATIC_PREFIX}/${entry.path}`, `${directory}/${entry.path}`)
    )

    /**
     * A serverless function, because Meet deploys them and a static-only test
     * proves nothing about them. Build Output API v3: a `.func` directory with
     * a `.vc-config.json` naming the runtime and handler, and `config.json`
     * routing to it. Same shape the consumer injects for its gatekeeper middleware.
     */
    const fn = ".vercel/output/functions/hello.func"
    const functionFiles = [
      yield* Entry.text(
        `${fn}/.vc-config.json`,
        JSON.stringify({ runtime: "nodejs20.x", handler: "index.js", launcherType: "Nodejs" })
      ),
      yield* Entry.text(
        `${fn}/index.js`,
        "module.exports = (req, res) => { res.setHeader('content-type','text/plain'); res.end('deploykit') }"
      ),
      yield* Entry.text(`${fn}/package.json`, JSON.stringify({ type: "commonjs" }))
    ]

    const config = yield* Entry.text(
      ".vercel/output/config.json",
      JSON.stringify({ version: 3, routes: [{ src: "/api/hello", dest: "/hello" }] })
    )

    /**
     * Layers rather than one flat list, which is how a real publish is built:
     * a prebuilt template underneath, generated files on top. The overrides it
     * reports are the thing a flat merge throws away.
     */
    const layers = [
      { name: "template", entries: staticFiles },
      { name: "functions", entries: functionFiles },
      { name: "generated", entries: [config] }
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
    const clashes = Artifact.collisionsWithinLayers(composed)
    if (clashes.length > 0) {
      yield* Effect.log(`WARNING ${clashes.length} collisions inside a single layer`)
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

    const probe = Effect.promise(async () => {
      const response = await fetch(url, { redirect: "manual" })
      return {
        status: response.status,
        location: response.headers.get("location"),
        body: await response.text().catch(() => "")
      }
    })

    /**
     * READY is not the same as serving. A brand new deployment URL can 404 for
     * a moment while it propagates, so a single fetch right after the status
     * turns terminal tests the race, not the deploy. Retry through 404 and 5xx
     * and report how long it took, which is itself worth knowing.
     */
    const response = yield* probe.pipe(
      Effect.tap(r =>
        r.status === 404 || r.status >= 500
          ? Effect.log(`  not live yet (HTTP ${r.status}), waiting`)
          : Effect.void
      ),
      Effect.repeat({
        until: r => r.status !== 404 && r.status < 500,
        schedule: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "90 seconds" }))
      })
    )

    const waited = ((Date.now() - started) / 1000).toFixed(1)

    if (response.status >= 300 && response.status < 400) {
      return yield* new NotServing({
        url,
        status: response.status,
        detail: `redirected to ${response.location ?? "somewhere"}. Deployment protection is probably on, so this run is inconclusive rather than failed.`
      })
    }
    if (response.status === 401 || response.status === 403) {
      return yield* new NotServing({
        url,
        status: response.status,
        detail: "deployment protection is on, so the check cannot see the page. Inconclusive."
      })
    }
    if (response.status === 404 || response.status >= 500) {
      return yield* new NotServing({
        url,
        status: response.status,
        detail: `still not serving after ${waited}s. ${response.body.slice(0, 200)}`
      })
    }
    if (response.body !== expectedIndex) {
      return yield* new NotServing({
        url,
        status: response.status,
        detail: `served ${response.body.length} bytes but we uploaded ${expectedIndex.length}. First 200 served: ${response.body.slice(0, 200)}`
      })
    }

    yield* Effect.log(
      `serving: HTTP 200 after ${waited}s, ${response.body.length} chars, identical to the file we uploaded`
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
  const name = process.argv[3] ?? `deploykit-smoke-${Date.now()}`

  const provider = yield* Provider.DeploymentProvider

  const fs = yield* FileSystem.FileSystem
  const expectedIndex = yield* fs.readFileString(`${directory}/index.html`)

  const artifact = yield* buildOutput(directory)
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

        const settled = yield* provider.getDeployment(started.id).pipe(
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
          yield* verifyFunction(settled.url)
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

// provideMerge, not provide: the program itself reads the directory, so it
// needs FileSystem too, not only the adapter underneath it.
const runtime = vercelLayer.pipe(Layer.provideMerge(NodeFileSystem.layer))

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
