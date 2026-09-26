import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Telemetry from "@deploykit/core/telemetry"
import { Provider } from "@deploykit/core"
import { makeVercelClient } from "@deploykit/vercel"

it.effect("telemetry preserves failures and omits sensitive error fields", () =>
  Effect.gen(function* () {
    const events: Array<Telemetry.Event> = []
    const error = new Provider.ProviderError({
      provider: "vercel",
      message: "secret message",
      body: "secret body",
      operation: "createDeployment",
      outcome: "unknown",
      recovery: "reconcile",
      requestId: "request-1"
    })
    const result = yield* Effect.flip(
      Telemetry.observe("vercel", "create", Effect.fail(error)).pipe(
        Effect.provideService(Telemetry.Observer, event =>
          Effect.sync(() => {
            events.push(event)
          })
        )
      )
    )
    assert.strictEqual(result, error)
    assert.equal(events.length, 2)
    assert.notInclude(JSON.stringify(events), "secret")
    const finished = events[1]
    assert(finished?.kind === "operation.finished")
    assert.equal(finished.failure?.outcome, "unknown")
    assert.equal(finished.failure?.recovery, "reconcile")
    assert.equal(finished.failure?.requestId, "request-1")
  })
)
it.effect("broken telemetry does not alter successful operations", () =>
  Effect.gen(function* () {
    const value = yield* Telemetry.observe("test", "operation", Effect.succeed(42)).pipe(
      Effect.provideService(Telemetry.Observer, () => Effect.die("observer broke"))
    )
    assert.equal(value, 42)
  })
)
it.effect("nested operations retain their parent identifiers", () =>
  Effect.gen(function* () {
    const events: Array<Telemetry.Event> = []
    yield* Telemetry.observe("test", "outer", Telemetry.observe("test", "inner", Effect.void)).pipe(
      Effect.provideService(Telemetry.Observer, event =>
        Effect.sync(() => {
          events.push(event)
        })
      )
    )
    const first = events[0],
      second = events[1]
    assert(first?.kind === "operation.started" && second?.kind === "operation.started")
    assert.equal(second.parentId, first.id)
  })
)
it.live(
  "HTTP retries expose attempts and actual scheduled backoff without request credentials",
  () =>
    Effect.gen(function* () {
      const events: Array<Telemetry.Event> = []
      let attempts = 0
      const client = makeVercelClient({
        token: "secret-token",
        retry: { attempts: 2, baseDelay: "1 millis" },
        fetch: async () => {
          attempts++
          return attempts === 1
            ? new Response("{}", { status: 429 })
            : Response.json({ id: "project", name: "test" })
        }
      })
      yield* client.getProject("project").pipe(
        Effect.provideService(Telemetry.Observer, event =>
          Effect.sync(() => {
            events.push(event)
          })
        )
      )
      assert.equal(attempts, 2)
      assert.equal(events.filter(event => event.kind === "operation.started").length, 2)
      assert.equal(events.filter(event => event.kind === "retry.scheduled").length, 1)
      assert.notInclude(JSON.stringify(events), "secret-token")
    })
)
it.live("exhausted retries do not announce a nonexistent next attempt", () =>
  Effect.gen(function* () {
    for (const attempts of [1, 2]) {
      const events: Array<Telemetry.Event> = []
      const client = makeVercelClient({
        token: "token",
        retry: { attempts, baseDelay: "1 millis" },
        fetch: async () => new Response("{}", { status: 503 })
      })
      yield* Effect.flip(
        client.getProject("project").pipe(
          Effect.provideService(Telemetry.Observer, event =>
            Effect.sync(() => {
              events.push(event)
            })
          )
        )
      )
      assert.equal(events.filter(event => event.kind === "retry.scheduled").length, attempts - 1)
    }
  })
)
