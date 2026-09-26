/**
 * Live qualification for features only tested against fakes: listing, rollback,
 * deleting deployments, password access and rate limiting.
 *
 *   DEPLOYKIT_ISOLATED=1 CLEANUP=1 PROVIDER=vercel bun scripts/qualify.ts
 *
 * Creates one throwaway project named deploykit-qualify-*, never touches any
 * other. ACCESS_PROBE=1 tries password protection (needs an entitled plan).
 * RATE_PROBE=1 sends a bounded burst of reads to see real 429 handling.
 */

import { Config, Effect, Layer, Schedule, Schema } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Deploykit, Entry, Provider } from "@deploykit/core"
import * as Cloudflare from "@deploykit/cloudflare"
import * as Vercel from "@deploykit/vercel"

const provider: "vercel" | "cloudflare" =
  process.env["PROVIDER"] === "cloudflare" ? "cloudflare" : "vercel"

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String
}) {}
class QualificationError extends Schema.TaggedError<QualificationError>()("QualificationError", {
  check: Schema.String,
  message: Schema.String
}) {}

/** Counts what the shared gate saw, which is what a Redis-backed gate would see. */
const gateSeen = { requests: 0, backoffs: [] as Array<number> }
const gate: Provider.RequestGate = {
  acquire: () => Effect.sync(() => void gateSeen.requests++),
  backoff: delayMs => Effect.sync(() => void gateSeen.backoffs.push(delayMs))
}

const layer = Effect.gen(function* () {
  if (provider === "vercel") {
    const token = yield* Config.string("VERCEL_TOKEN")
    const teamId = yield* Config.option(Config.string("VERCEL_TEAM_ID"))
    return Vercel.layer({
      token,
      gate,
      ...(teamId._tag === "Some" ? { teamId: teamId.value } : {})
    })
  }
  return Cloudflare.layer({
    apiToken: yield* Config.string("CLOUDFLARE_API_TOKEN"),
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    gate
  })
})

/** One page whose body names the release, laid out as each provider expects. */
const release = (label: string) =>
  Effect.gen(function* () {
    const html = `<!doctype html><title>${label}</title>${label}`
    const entries =
      provider === "vercel"
        ? [
            yield* Entry.text(".vercel/output/config.json", '{"version":3}'),
            yield* Entry.text(".vercel/output/static/index.html", html)
          ]
        : [yield* Entry.text("index.html", html)]
    return yield* Artifact.make(entries)
  })

const productionUrl = (name: string) =>
  provider === "vercel" ? `https://${name}.vercel.app` : `https://${name}.pages.dev`

/** Production routing is eventually consistent, so poll for the expected body. */
const servesRelease = (url: string, label: string) =>
  Effect.tryPromise(async signal => {
    const response = await fetch(url, { signal, cache: "no-store" })
    return (await response.text()).includes(label)
  }).pipe(
    Effect.flatMap(found =>
      found
        ? Effect.void
        : new QualificationError({ check: "rollback", message: `${url} is not serving ${label}` })
    ),
    Effect.retry(Schedule.spaced("3 seconds").pipe(Schedule.upTo({ duration: "2 minutes" })))
  )

const check = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.tap(() => Effect.log(`pass: ${name}`)),
    Effect.tapError(error => Effect.logError(`fail: ${name}`, error))
  )

const qualify = (name: string) =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    const app = yield* check("createApp", deploykit.createApp(name))
    const wait = {
      wait: {
        schedule: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "5 minutes" }))
      }
    }

    const first = yield* check(
      "deployAndWait (first release)",
      deploykit.deployAndWait(app.id, yield* release("release-one"), wait)
    )
    const second = yield* check(
      "deployAndWait (second release)",
      deploykit.deployAndWait(app.id, yield* release("release-two"), wait)
    )
    yield* check("second release serves", servesRelease(productionUrl(name), "release-two"))

    yield* check(
      "listDeployments newest first",
      deploykit.listDeployments(app.id, { target: "production" }).pipe(
        Effect.flatMap(([newest, previous]) =>
          newest?.id === second.id && previous?.id === first.id
            ? Effect.void
            : new QualificationError({
                check: "listDeployments",
                message: `expected ${second.id}, ${first.id}; got ${newest?.id}, ${previous?.id}`
              })
        )
      )
    )

    yield* check("rollback to first release", deploykit.rollback(app.id, first.id))
    yield* check("first release serves again", servesRelease(productionUrl(name), "release-one"))

    yield* check(
      "deleting the live deployment is refused",
      Effect.flip(deploykit.deleteDeployment(app.id, first.id)).pipe(
        Effect.flatMap(error =>
          error._tag === "UnsupportedError"
            ? Effect.void
            : new QualificationError({ check: "deleteDeployment", message: error.message })
        )
      )
    )
    yield* check(
      "delete the rolled-back-from release",
      deploykit.deleteDeployment(app.id, second.id)
    )

    if (process.env["ACCESS_PROBE"] === "1") {
      const outcome = yield* Effect.result(
        deploykit.setAccess(app.id, { _tag: "Password", password: `qualify-${Date.now()}` })
      )
      yield* Effect.log(
        outcome._tag === "Success"
          ? "access: password protection applied"
          : `access: ${outcome.failure._tag}, recovery ${Provider.recoveryOf(outcome.failure)}`
      )
    }

    if (process.env["RATE_PROBE"] === "1") {
      // Bounded: 300 reads, 30 at a time. Enough to meet most per-token limits once.
      const results = yield* Effect.forEach(
        Array.from({ length: 300 }),
        () => Effect.result(deploykit.getDeployment(app.id, first.id)),
        { concurrency: 30 }
      )
      const failed = results.filter(result => result._tag === "Failure")
      yield* Effect.log(
        `rate: ${results.length} reads, ${failed.length} failed, ${gateSeen.backoffs.length} 429s seen (Retry-After ms: ${gateSeen.backoffs.slice(0, 5).join(", ") || "none"})`
      )
      if (failed.length > 0)
        return yield* new QualificationError({
          check: "rate",
          message: "reads failed under throttling; see recovery on the errors above"
        })
    }
    return app
  })

const program = Effect.gen(function* () {
  if (
    process.env["DEPLOYKIT_ISOLATED"] !== "1" ||
    !["0", "1"].includes(process.env["CLEANUP"] ?? "")
  )
    return yield* new UsageError({
      message:
        "Use an isolated account and set DEPLOYKIT_ISOLATED=1; choose CLEANUP=1, or CLEANUP=0 to keep the project"
    })
  const name = `deploykit-qualify-${Date.now().toString(36)}`
  const live = (yield* layer).pipe(Layer.provide(NodeFileSystem.layer))
  yield* Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    yield* qualify(name).pipe(
      Effect.ensuring(
        process.env["CLEANUP"] === "1"
          ? deploykit.findAppByName(name).pipe(
              Effect.flatMap(found =>
                found._tag === "Some" ? deploykit.deleteApp(found.value.id) : Effect.void
              ),
              Effect.tap(() => Effect.log(`cleanup: deleted ${name}`)),
              Effect.ignore
            )
          : Effect.log(`kept ${name}`)
      )
    )
    yield* Effect.log(`qualified ${provider}; gate saw ${gateSeen.requests} requests`)
  }).pipe(Effect.provide(live))
})

await Effect.runPromise(program)
