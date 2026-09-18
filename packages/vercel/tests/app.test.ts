import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  createVercelProject,
  deleteVercelProject,
  findVercelProjectByName,
  getVercelProject
} from "../src/services/app.ts"
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

      assert.deepStrictEqual(stub.projectCalls[0], { op: "createProject", arg: "alpha" })
    })
  )

  it.effect("reports the requested name on failure, since there is no id yet", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithoutResponse: "name already in use" })

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
      assert.strictEqual(stub.projectCalls[0]?.arg, "prj_1")
    })
  )

  it.effect("reports the requested id on failure", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithoutResponse: "not found" })

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

      assert.strictEqual(stub.projectCalls[0]?.arg, "prj_1")
    })
  )

  it.effect("reports the app id on failure, so a failed compensation is traceable", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithoutResponse: "project in use" })

      const error = yield* Effect.flip(deleteVercelProject(stub.client, "prj_1"))

      assert.strictEqual(error.message, "project in use")
      assert.strictEqual(error.appId, "prj_1")
      assert.strictEqual(error.provider, "vercel")
    })
  )
})

describe("findVercelProjectByName", () => {
  it.effect("finds a project by name, since Vercel resolves id or name", () =>
    Effect.gen(function* () {
      const stub = stubClient({ project: { id: "prj_1", name: "alpha" } })

      const found = yield* findVercelProjectByName(stub.client, "alpha")

      assert.isTrue(Option.isSome(found))
      assert.strictEqual(Option.getOrThrow(found).id, "prj_1")
      assert.strictEqual(stub.projectCalls[0]?.arg, "alpha")
    })
  )

  it.effect("treats a 404 as None, not as a failure", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithStatus: 404 })

      const found = yield* findVercelProjectByName(stub.client, "nope")

      assert.isTrue(Option.isNone(found), "absence is an answer")
    })
  )

  it.effect("still fails on a real error, so outages are not read as absence", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithStatus: 500 })

      const error = yield* Effect.flip(findVercelProjectByName(stub.client, "alpha"))

      assert.strictEqual(error._tag, "ProviderError")
      assert.strictEqual(error.appName, "alpha")
    })
  )
})
