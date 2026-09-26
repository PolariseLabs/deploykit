import { createClient } from "@deploykit/node/vercel"
import type { VercelOptions } from "@deploykit/node/vercel"

export async function deployStoredArtifact(
  config: VercelOptions,
  input: {
    appId: string
    operationId: string
    manifest: unknown
    resolveSource: (reference: string, signal: AbortSignal) => Promise<URL>
    signal: AbortSignal
  }
) {
  const client = createClient(config)
  try {
    return await client.deployManifest(
      input.appId,
      input.manifest,
      async (reference, signal) => {
        const url = await input.resolveSource(reference, signal)
        const response = await fetch(url, { signal, redirect: "error" })
        if (!response.ok || response.body === null) {
          await response.body?.cancel()
          throw new Error(`Artifact store returned ${response.status}`)
        }
        return response.body
      },
      {
        target: "production",
        activation: "deferred",
        operationId: input.operationId,
        signal: input.signal
      }
    )
  } finally {
    await client.close()
  }
}
