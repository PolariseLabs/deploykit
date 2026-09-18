import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { createVercelProject, deleteVercelProject, getVercelProject } from "../src/services/app.ts"
import { stubClient } from "./stub.ts"

describe("createVercelProject", () => {
  it.effect("maps a Vercel project onto the portable App", () =>
    Effect.gen(function* () {
      const stub = stubClient({ project: { id: "prj_1", name: "alpha" } })

      const app = yield* createVercelProject(stub.client, "alpha")

      assert.strictEqual(app.id, "prj_1")
      assert.strictEqual(app.name, "alpha")
    })
  )

  it.effect("asks Vercel for the requested name", () =>
    Effect.gen(function* () {
      const stub = stubClient()

      yield* createVercelProject(stub.client, "alpha")

      const request = stub.projectRequests[0] as { requestBody: { name: string } }
      assert.strictEqual(request.requestBody.name, "alpha")
    })
  )

  it.effect("reports the requested name on failure, since there is no id yet", () =>
    Effect.gen(function* () {
      const stub = stubClient({ rejectWith: new Error("name already in use") })

      const error = yield* Effect.flip(createVercelProject(stub.client, "alpha"))

      assert.strictEqual(error.message, "name already in use")
      assert.strictEqual(error.appName, "alpha")
      assert.strictEqual(error.appId, undefined)
      assert.strictEqual(error.provider, "vercel")
    })
  )
})

describe("getVercelProject", () => {
  it.effect("resolves a project by id or name", () =>
    Effect.gen(function* () {
      const stub = stubClient({ project: { id: "prj_1", name: "alpha" } })

      const app = yield* getVercelProject(stub.client, "prj_1")

      assert.strictEqual(app.id, "prj_1")
      const request = stub.projectRequests[0] as { idOrName: string }
      assert.strictEqual(request.idOrName, "prj_1")
    })
  )

  it.effect("reports the requested id on failure", () =>
    Effect.gen(function* () {
      const stub = stubClient({ rejectWith: new Error("not found") })

      const error = yield* Effect.flip(getVercelProject(stub.client, "prj_missing"))

      assert.strictEqual(error.appId, "prj_missing")
      assert.strictEqual(error.appName, undefined)
    })
  )
})

describe("deleteVercelProject", () => {
  it.effect("asks Vercel to delete the requested project", () =>
    Effect.gen(function* () {
      const stub = stubClient()

      yield* deleteVercelProject(stub.client, "prj_1")

      const request = stub.projectRequests[0] as { idOrName: string }
      assert.strictEqual(request.idOrName, "prj_1")
    })
  )

  it.effect("reports the app id on failure, so a failed compensation is traceable", () =>
    Effect.gen(function* () {
      const stub = stubClient({ rejectWith: new Error("project in use") })

      const error = yield* Effect.flip(deleteVercelProject(stub.client, "prj_1"))

      assert.strictEqual(error.message, "project in use")
      assert.strictEqual(error.appId, "prj_1")
      assert.strictEqual(error.provider, "vercel")
    })
  )
})
