import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { TransferLimitError } from "../src/index.ts"
import { artifactFromFiles, createVercelClient } from "../src/edge.ts"

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")

/** Vercel asks for the one file, then accepts the deployment once it has arrived. */
const vercel = () => {
  let uploaded = false
  return createVercelClient({
    token: "test",
    fetch: async input => {
      if (String(input).includes("/v2/files")) {
        uploaded = true
        return new Response("{}")
      }
      return uploaded
        ? Response.json({
            id: "dpl_1",
            projectId: "app",
            readyState: "READY",
            target: "production"
          })
        : Response.json(
            { error: { code: "missing_files", missing: [sha1("hello")] } },
            { status: 400 }
          )
    }
  })
}

test("the edge client deploys in-memory files without a filesystem", async () => {
  const client = vercel()
  try {
    const artifact = await artifactFromFiles([{ path: "index.html", text: "hello" }])
    expect((await client.deploy("app", artifact)).id).toBe("dpl_1")
  } finally {
    await client.close()
  }
})

test("files that would need disk staging are refused up front, as a fixable input", async () => {
  const client = vercel()
  try {
    const big = await artifactFromFiles([
      { path: "video.mp4", bytes: new Uint8Array(9 * 1024 * 1024) }
    ])
    await expect(client.deploy("app", big)).rejects.toBeInstanceOf(TransferLimitError)
  } finally {
    await client.close()
  }
})

test("deploying a directory fails as an error, not a crash", async () => {
  const client = vercel()
  try {
    await expect(client.deployDirectory("app", "./build")).rejects.toMatchObject({
      _tag: "PlatformError"
    })
  } finally {
    await client.close()
  }
})
