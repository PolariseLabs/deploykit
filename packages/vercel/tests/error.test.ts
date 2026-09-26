import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Provider from "@deploykit/core/provider"
import { makeVercelClient, makeVercelControl } from "../src/control.ts"

it.effect("password protection rejection is typed, serializable and not retried", () =>
  Effect.gen(function* () {
    let requests = 0
    const control = makeVercelControl(
      makeVercelClient({
        token: "test",
        fetch: async () => {
          requests++
          return Response.json(
            { error: { code: "invalid_password_protection" } },
            {
              status: 428,
              headers: { "x-vercel-id": "request-1" }
            }
          )
        }
      })
    )
    const failure = yield* Effect.flip(
      control.setAccess!("app", { _tag: "Password", password: "private" })
    )
    assert.strictEqual(failure._tag, "ProviderError")
    if (failure._tag !== "ProviderError") return
    assert.strictEqual(failure.operation, "setProjectAccess")
    assert.strictEqual(failure.code, "invalid_password_protection")
    assert.strictEqual(failure.statusCode, 428)
    assert.strictEqual(failure.outcome, "rejected")
    assert.strictEqual(failure.recovery, "fix-input")
    assert.strictEqual(requests, 1)
    const wire = yield* Provider.encodeFailure(failure)
    assert.notInclude(wire, "private")
    const decoded = yield* Provider.decodeFailure(wire)
    assert.strictEqual(decoded._tag, "ProviderError")
    if (decoded._tag === "ProviderError") assert.strictEqual(decoded.outcome, "rejected")
  })
)

it.effect("unrecognized access responses remain ambiguous", () =>
  Effect.gen(function* () {
    const control = makeVercelControl(
      makeVercelClient({
        token: "test",
        fetch: async () => Response.json({ error: { code: "unrecognized" } }, { status: 428 })
      })
    )
    const failure = yield* Effect.flip(control.setAccess!("app", { _tag: "SingleSignOn" }))
    assert.strictEqual(failure._tag, "ProviderError")
    if (failure._tag === "ProviderError") {
      assert.strictEqual(failure.outcome, "unknown")
      assert.strictEqual(failure.recovery, "reconcile")
    }
  })
)
