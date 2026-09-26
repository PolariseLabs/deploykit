import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Provider } from "@deploykit/core"
import { safeBody } from "@deploykit/core/http"

it.effect("wire failures preserve identity and recovery evidence", () =>
  Effect.gen(function* () {
    for (const error of [
      new Provider.ProviderError({
        provider: "vercel",
        operation: "createDeployment",
        message: "Response lost",
        outcome: "unknown",
        recovery: "reconcile",
        deploymentId: "known",
        requestId: "request-1"
      }),
      new Provider.SourceError({ reference: "blob:1", message: "Read failed" }),
      new Provider.IntegrityError({ path: "index.html", message: "Mismatch" })
    ]) {
      const decoded = yield* Provider.decodeFailure(yield* Provider.encodeFailure(error))
      assert.strictEqual(decoded._tag, error._tag)
      assert.strictEqual(
        yield* Provider.encodeFailure(decoded),
        yield* Provider.encodeFailure(error)
      )
    }
    assert.strictEqual(
      (yield* Effect.flip(Provider.decodeFailure('{"version":2}')))._tag,
      "ValidationError"
    )
  })
)
it("diagnostics discard secrets and free-form response messages", () => {
  const body = safeBody(
    JSON.stringify({
      error: {
        code: "invalid_digest",
        message: "Bearer secret",
        token: "private",
        missing: ["a".repeat(40)]
      },
      jwt: "private"
    })
  )
  assert.notInclude(body, "secret")
  assert.notInclude(body, "private")
  assert.include(body, "invalid_digest")
  assert.strictEqual(safeBody("secret html"), "[redacted]")
})
