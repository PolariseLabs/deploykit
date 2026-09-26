import { assert, it } from "@effect/vitest"
import * as Provider from "@deploykit/core/provider"
import { Effect } from "effect"
import { makeVercelClient, makeVercelControl } from "../src/control.ts"

it.effect("staged production activation preserves identity and requires observation", () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.includes("/promote/")) return new Response(null, { status: 202 })
      if (url.includes("/deployments/"))
        return Response.json({
          id: "dpl_1",
          projectId: "app",
          readyState: "READY",
          target: "production"
        })
      return Response.json({ id: "app", name: "app", targets: { production: { id: "dpl_1" } } })
    }
    const control = makeVercelControl(makeVercelClient({ token: "test", fetch: fetcher }))
    const requested = yield* control.activateDeployment!("app", "dpl_1")
    assert.strictEqual(requested.state, "pending")
    assert.strictEqual((yield* control.getActivation!("app", "dpl_1")).state, "active")
    assert.strictEqual(calls.filter(call => call.startsWith("POST")).length, 1)
    assert.include(calls[1]!, "/promote/dpl_1")
  })
)
it.effect("preview and foreign-app activation fail before promotion", () =>
  Effect.gen(function* () {
    for (const deployment of [
      { target: "preview", projectId: "app" },
      { target: "production", projectId: "other" }
    ]) {
      let writes = 0
      const control = makeVercelControl(
        makeVercelClient({
          token: "test",
          fetch: async (_input, init) => {
            if (init?.method === "POST") writes++
            return Response.json({ id: "dpl", readyState: "READY", ...deployment })
          }
        })
      )
      const error = yield* Effect.flip(control.activateDeployment!("app", "dpl"))
      assert.strictEqual(error._tag, "UnsupportedError")
      assert.strictEqual(writes, 0)
    }
  })
)
it.effect("reconciliation never infers absence or chooses between duplicates", () =>
  Effect.gen(function* () {
    for (const count of [0, 1, 2]) {
      const control = makeVercelControl(
        makeVercelClient({
          token: "test",
          fetch: async () =>
            Response.json({
              deployments: Array.from({ length: count }, (_, n) => ({
                uid: `dpl_${n}`,
                name: "app",
                readyState: "READY",
                meta: { deploykitOperationId: "op" }
              })),
              pagination: { next: null }
            })
        })
      )
      const result = yield* control.reconcileDeployment!("app", "op")
      assert.strictEqual(result._tag, count === 1 ? "Recovered" : "Unknown")
    }
  })
)
it.effect("lost and malformed create responses remain ambiguous without retries", () =>
  Effect.gen(function* () {
    for (const body of [undefined, "not json"]) {
      let requests = 0
      const control = makeVercelControl(
        makeVercelClient({
          token: "test",
          fetch: async () => {
            requests++
            if (body === undefined) throw new Error("lost after acceptance")
            return new Response(body)
          }
        })
      )
      const error = yield* Effect.flip(control.createApp("app"))
      assert.strictEqual(error.outcome, "unknown")
      assert.strictEqual(error.recovery, "reconcile")
      assert.strictEqual(requests, 1)
    }
  })
)

it.effect("a malformed creation result retains an available deployment ID", () =>
  Effect.gen(function* () {
    const client = makeVercelClient({
      token: "test",
      fetch: async () => Response.json({ id: "dpl_known", readyState: "NEW_STATE" })
    })
    const error = yield* Effect.flip(
      client.createDeployment({ projectId: "app", name: "app", target: "production", files: [] })
    )
    assert.strictEqual(error.deploymentId, "dpl_known")
  })
)

it.effect("control reports preview support", () =>
  Effect.sync(() => {
    const control = makeVercelControl(makeVercelClient({ token: "test" }))
    assert.isTrue(Provider.capabilitiesOf(control).previewDeployments)
  })
)
