import { assert, describe, it } from "@effect/vitest"
import { mapLatestStage, type PagesStage, type PagesStatus } from "../src/services/status.ts"

const STAGES: ReadonlyArray<PagesStage> = ["queued", "initialize", "clone_repo", "build", "deploy"]
const STATUSES: ReadonlyArray<PagesStatus> = ["idle", "active", "success", "failure", "canceled"]

describe("the whole matrix", () => {
  /**
   * Twenty-five combinations, every one pinned. Vercel needed seven cases;
   * Cloudflare's state is a pair, and the difference between the two is the
   * main thing a second provider was meant to expose.
   */
  const expected: Record<string, Provider_DeploymentStatus> = {
    "queued/idle": "pending",
    "queued/active": "pending",
    "queued/success": "deploying",
    "queued/failure": "failed",
    "queued/canceled": "failed",

    "initialize/idle": "pending",
    "initialize/active": "pending",
    "initialize/success": "deploying",
    "initialize/failure": "failed",
    "initialize/canceled": "failed",

    "clone_repo/idle": "pending",
    "clone_repo/active": "deploying",
    "clone_repo/success": "deploying",
    "clone_repo/failure": "failed",
    "clone_repo/canceled": "failed",

    "build/idle": "pending",
    "build/active": "deploying",
    "build/success": "deploying",
    "build/failure": "failed",
    "build/canceled": "failed",

    "deploy/idle": "pending",
    "deploy/active": "deploying",
    "deploy/success": "deployed",
    "deploy/failure": "failed",
    "deploy/canceled": "failed"
  }

  for (const stage of STAGES) {
    for (const status of STATUSES) {
      const key = `${stage}/${status}`
      it(`${key} is ${expected[key]}`, () => {
        assert.strictEqual(mapLatestStage(stage, status), expected[key])
      })
    }
  }
})

describe("the traps", () => {
  /**
   * The one a status-only mapping gets wrong. build/success means the build
   * finished and the deploy stage has not run, so reporting it as deployed
   * would tell a caller the site is live while it is not.
   */
  it("build/success is not deployed", () => {
    assert.strictEqual(mapLatestStage("build", "success"), "deploying")
    assert.strictEqual(mapLatestStage("deploy", "success"), "deployed")
  })

  it("only the deploy stage succeeding is terminal success", () => {
    const deployed = STAGES.filter(stage => mapLatestStage(stage, "success") === "deployed")
    assert.deepStrictEqual(deployed, ["deploy"])
  })

  /** A failure anywhere is terminal, including before anything was built. */
  it("a failure at any stage is failed", () => {
    for (const stage of STAGES) {
      assert.strictEqual(mapLatestStage(stage, "failure"), "failed", stage)
      assert.strictEqual(mapLatestStage(stage, "canceled"), "failed", stage)
    }
  })

  /** idle means not started, even at the last stage. */
  it("deploy/idle is pending, not deploying", () => {
    assert.strictEqual(mapLatestStage("deploy", "idle"), "pending")
  })
})

type Provider_DeploymentStatus = "pending" | "deploying" | "deployed" | "failed"
