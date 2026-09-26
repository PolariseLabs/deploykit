import { waitUntilServing } from "@deploykit/node"
import type { Deployment } from "@deploykit/node"
import { createClient } from "@deploykit/node/vercel"
import type { VercelOptions } from "@deploykit/node/vercel"

export async function publishVercel(
  config: VercelOptions,
  input: {
    appId: string
    directory: string
    operationId: string
    recordCreated: (deployment: Deployment) => Promise<void>
    verify: (url: string, signal: AbortSignal) => Promise<void>
    signal?: AbortSignal
  }
) {
  const deadline = AbortSignal.timeout(5 * 60_000)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const client = createClient(config)
  try {
    const created = await client.deployDirectory(input.appId, input.directory, {
      target: "production",
      activation: "deferred",
      operationId: input.operationId,
      signal
    })
    await input.recordCreated(created)
    const ready = await client.waitUntilReady(input.appId, created.id, { signal })
    if (ready.status !== "deployed" || ready.url === undefined) {
      throw new Error(ready.reason ?? "Deployment did not become ready")
    }
    await waitUntilServing(ready.url, { signal, timeoutMs: 60_000 })
    await input.verify(ready.url, signal)
    return ready
  } finally {
    await client.close()
  }
}
