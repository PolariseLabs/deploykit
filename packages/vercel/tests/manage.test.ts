import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeVercelClient, makeVercelControl } from "../src/control.ts"

const deployment = (uid: string, readyState: string, target: string | null = "production") => ({
  uid,
  id: uid,
  name: "site",
  projectId: "prj",
  readyState,
  target,
  url: `${uid}.vercel.app`
})

/** A fake Vercel API that records each request as "METHOD path?query". */
const vercel = () => {
  const requests: Array<string> = []
  const control = makeVercelControl(
    makeVercelClient({
      token: "test",
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? "GET"
        requests.push(`${method} ${url.pathname}${url.search}`)
        if (url.pathname === "/v7/deployments")
          return Response.json({
            deployments: [
              deployment("dpl_new", "READY"),
              deployment("dpl_gone", "DELETED"),
              deployment("dpl_old", "READY")
            ],
            pagination: { count: 3, next: null, prev: null }
          })
        if (url.pathname.startsWith("/v13/deployments/") && method === "GET")
          return Response.json(deployment(url.pathname.split("/").at(-1)!, "READY"))
        if (url.pathname === "/v9/projects/prj")
          return Response.json({
            id: "prj",
            name: "site",
            targets: { production: { id: "dpl_live" } }
          })
        return Response.json({})
      }
    })
  )
  return { control, requests }
}

it.effect("lists newest first and skips deleted deployments", () =>
  Effect.gen(function* () {
    const { control, requests } = vercel()
    const listed = yield* control.listDeployments!("prj", { target: "production" })
    assert.deepStrictEqual(
      listed.map(item => item.id),
      ["dpl_new", "dpl_old"]
    )
    assert.deepStrictEqual(requests, [
      "GET /v7/deployments?projectId=prj&limit=20&target=production"
    ])
  })
)

it.effect("rollback promotes an older ready production deployment", () =>
  Effect.gen(function* () {
    const { control, requests } = vercel()
    const activation = yield* control.rollback!("prj", "dpl_old")
    assert.strictEqual(activation.state, "pending")
    assert.include(requests, "POST /v10/projects/prj/promote/dpl_old")
  })
)

it.effect("delete refuses the live deployment and deletes others by id", () =>
  Effect.gen(function* () {
    const { control, requests } = vercel()
    const refused = yield* Effect.flip(control.deleteDeployment!("prj", "dpl_live"))
    assert.strictEqual(refused._tag, "UnsupportedError")
    assert.notInclude(requests, "DELETE /v13/deployments/dpl_live")
    yield* control.deleteDeployment!("prj", "dpl_old")
    assert.include(requests, "DELETE /v13/deployments/dpl_old")
  })
)
