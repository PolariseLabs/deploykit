import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  manifestFromDirectory,
  ProviderError,
  AbortError,
  NotServingError,
  waitUntilServing
} from "@deploykit/node"
import { createClient } from "@deploykit/node/vercel"
import { createClient as createPages } from "@deploykit/node/cloudflare"
import { publishPreparedDirectory } from "./promise-api.ts"

const directory = await mkdtemp(join(tmpdir(), "deploykit-promise-"))
try {
  await assert.rejects(
    waitUntilServing("https://offline.example.test", { timeoutMs: 0 }),
    NotServingError
  )
  await mkdir(join(directory, ".vercel/output/static"), { recursive: true })
  await writeFile(join(directory, ".vercel/output/config.json"), '{"version":3}')
  await writeFile(join(directory, ".vercel/output/static/index.html"), "hello")
  const manifest = await manifestFromDirectory(directory, { source: path => `artifact:${path}` })
  assert.equal(manifest.entries.length, 2)
  assert.equal(
    manifest.entries.find(entry => entry.path.endsWith("index.html"))?.sha256,
    createHash("sha256").update("hello").digest("hex")
  )
  const deployment = await publishPreparedDirectory(
    {
      token: "offline",
      fetch: async () => Response.json({ id: "dpl_1", readyState: "READY" })
    },
    { appId: "app", directory, operationId: "promise-proof" }
  )
  assert.equal(deployment.id, "dpl_1")
  const client = createClient({
    token: "offline",
    retry: { attempts: 1 },
    fetch: async () => Response.json({ error: { code: "forbidden" } }, { status: 403 })
  })
  try {
    await assert.rejects(client.getDeployment("app", "dpl_1"), ProviderError)
    await assert.rejects(client.getApp("app", { signal: AbortSignal.abort() }), AbortError)
  } finally {
    await client.close()
  }
  const pages = createPages({ apiToken: "offline", accountId: "offline" })
  try {
    assert.equal((await pages.getCapabilities()).deferredActivation, false)
  } finally {
    await pages.close()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log(
  "Packed Promise consumer passed: no Effect imports, directory deployment, streaming manifest, typed errors, cancellation, both providers"
)
