import { expect, test } from "vitest"
import { DeploymentFailedError, artifactFromFiles } from "../src/index.ts"
import { createTestClient } from "../src/test.ts"

test("the test client deploys in memory and records what it was given", async () => {
  const deploykit = createTestClient()
  try {
    const app = await deploykit.createApp("site")
    const artifact = await artifactFromFiles([{ path: "index.html", text: "hi" }])
    const live = await deploykit.deployAndWait(app.id, artifact, { wait: { intervalMs: 1 } })
    expect(live.status).toBe("deployed")
    expect((await deploykit.snapshot()).deployments.size).toBe(1)
  } finally {
    await deploykit.close()
  }
})

test("configured build failures reach callers as DeploymentFailedError", async () => {
  const deploykit = createTestClient({ failOn: { build: ["app-1"] } })
  try {
    const app = await deploykit.createApp("site")
    const artifact = await artifactFromFiles([])
    await expect(
      deploykit.deployAndWait(app.id, artifact, { wait: { intervalMs: 1 } })
    ).rejects.toBeInstanceOf(DeploymentFailedError)
  } finally {
    await deploykit.close()
  }
})
