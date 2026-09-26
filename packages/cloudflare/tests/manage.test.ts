import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCloudflareClient } from "../src/services/http.ts"
import { makeCloudflareControl } from "../src/control.ts"

const deployment = (id: string, environment = "production") => ({
  id,
  environment,
  url: `https://${id}.site.pages.dev`,
  latest_stage: { name: "deploy", status: "success" }
})

/** A fake Pages API that records each request as "METHOD path?query". */
const pages = () => {
  const requests: Array<string> = []
  const control = makeCloudflareControl(
    makeCloudflareClient({
      apiToken: "test",
      accountId: "acct",
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? "GET"
        requests.push(
          `${method} ${url.pathname.replace("/client/v4/accounts/acct/pages/projects", "")}${url.search}`
        )
        const result =
          url.pathname.endsWith("/deployments") && method === "GET"
            ? [deployment("new"), deployment("old")]
            : url.pathname.endsWith("/rollback")
              ? deployment("old")
              : url.pathname.endsWith("/projects/site")
                ? { id: "p", name: "site", canonical_deployment: { id: "live" } }
                : null
        return Response.json({ success: true, errors: [], result })
      }
    })
  )
  return { control, requests }
}

it.effect("lists newest first with the page size and environment Pages expects", () =>
  Effect.gen(function* () {
    const { control, requests } = pages()
    const listed = yield* control.listDeployments!("site", { target: "production", limit: 500 })
    assert.deepStrictEqual(
      listed.map(item => [item.id, item.status]),
      [
        ["new", "deployed"],
        ["old", "deployed"]
      ]
    )
    assert.deepStrictEqual(requests, ["GET /site/deployments?per_page=100&env=production"])
  })
)

it.effect("rollback posts to the deployment and reports production as switched", () =>
  Effect.gen(function* () {
    const { control, requests } = pages()
    const activation = yield* control.rollback!("site", "old")
    assert.strictEqual(activation.state, "active")
    assert.deepStrictEqual(requests, ["POST /site/deployments/old/rollback"])
  })
)

it.effect("delete refuses the deployment serving production and removes others", () =>
  Effect.gen(function* () {
    const { control, requests } = pages()
    const refused = yield* Effect.flip(control.deleteDeployment!("site", "live"))
    assert.strictEqual(refused._tag, "UnsupportedError")
    yield* control.deleteDeployment!("site", "old")
    assert.deepStrictEqual(requests, ["GET /site", "GET /site", "DELETE /site/deployments/old"])
  })
)
