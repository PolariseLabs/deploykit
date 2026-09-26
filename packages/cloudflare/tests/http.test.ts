import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCloudflareClient } from "../src/services/http.ts"
import { makeCloudflareControl } from "../src/control.ts"

it.effect("single-attempt mode covers internal errors, throttling and transport failures", () =>
  Effect.gen(function* () {
    for (const status of [200, 429, 503, 0]) {
      let calls = 0
      const client = makeCloudflareClient({
        apiToken: "secret",
        accountId: "test",
        retry: { attempts: 1 },
        fetch: async () => {
          calls++
          if (status === 0) throw new Error("token=secret")
          return Response.json(
            { success: false, errors: [{ code: 8000000, message: "secret" }], result: null },
            { status }
          )
        }
      })
      const error = yield* Effect.flip(makeCloudflareControl(client).getApp("app"))
      assert.strictEqual(calls, 1)
      assert.strictEqual(error.outcome, "observation-failed")
      assert.notInclude(JSON.stringify(error), "secret")
    }
  })
)
it.effect("create failures never retry or claim an ambiguous request was rejected", () =>
  Effect.gen(function* () {
    for (const status of [200, 429, 500]) {
      let calls = 0
      const control = makeCloudflareControl(
        makeCloudflareClient({
          apiToken: "test",
          accountId: "test",
          fetch: async () => {
            calls++
            return new Response("malformed", { status })
          }
        })
      )
      const error = yield* Effect.flip(control.createApp("app"))
      assert.strictEqual(calls, 1)
      assert.strictEqual(error.outcome, "unknown")
      assert.strictEqual(error.recovery, "reconcile")
    }
  })
)
it("deadline aborts an outstanding HTTP request", async () => {
  let aborted = false
  const client = makeCloudflareClient({
    apiToken: "test",
    accountId: "test",
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      })
  })
  const error = await Effect.runPromise(Effect.flip(client.getProject("app")))
  assert.include(error.message, "deadline")
  assert.isTrue(aborted)
})
