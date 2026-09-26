import { waitUntilServing } from "@deploykit/node"
import type { Deployment } from "@deploykit/node"
import { createClient } from "@deploykit/node/cloudflare"
import type { CloudflareOptions } from "@deploykit/node/cloudflare"

export async function publishPages(
  config: CloudflareOptions,
  input: {
    appId: string
    directory: string
    recordCreated: (deployment: Deployment) => Promise<void>
    signal?: AbortSignal
  }
) {
  const deadline = AbortSignal.timeout(5 * 60_000)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const client = createClient(config)
  try {
    const created = await client.deployDirectory(input.appId, input.directory, {
      target: "preview",
      signal
    })
    await input.recordCreated(created)
    const ready = await client.waitUntilReady(input.appId, created.id, { signal })
    if (ready.status !== "deployed" || ready.url === undefined) {
      throw new Error(ready.reason ?? "Deployment failed")
    }
    await waitUntilServing(ready.url, { signal })
    return ready
  } finally {
    await client.close()
  }
}
