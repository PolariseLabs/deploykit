import { createClient } from "@deploykit/node/vercel"
import type { VercelOptions } from "@deploykit/node/vercel"

export const publishPreparedDirectory = async (
  config: VercelOptions,
  input: { appId: string; directory: string; operationId: string; signal?: AbortSignal }
) => {
  const client = createClient(config)
  try {
    return await client.deployDirectory(input.appId, input.directory, {
      operationId: input.operationId,
      target: "production",
      activation: "deferred",
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
  } finally {
    await client.close()
  }
}
