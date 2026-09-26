import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Provider } from "@deploykit/core"

it.effect("a Promise gate whose store is down fails open", () =>
  Effect.gen(function* () {
    const gate = Provider.fromPromiseGate({
      acquire: () => Promise.reject(new Error("redis unreachable")),
      backoff: () => Promise.reject(new Error("redis unreachable"))
    })
    yield* gate.acquire("uploadFile")
    yield* gate.backoff(1000)
    assert.ok(true, "neither call failed the request")
  })
)
