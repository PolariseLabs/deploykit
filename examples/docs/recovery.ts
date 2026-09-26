import { ProviderError } from "@deploykit/node"
import { createClient } from "@deploykit/node/vercel"
import type { VercelOptions } from "@deploykit/node/vercel"

export async function recoverPublish(
  config: VercelOptions,
  input: { appId: string; operationId: string; signal: AbortSignal }
) {
  const client = createClient(config)
  try {
    const outcome = await client.reconcileDeployment(input.appId, input.operationId, {
      signal: input.signal
    })
    switch (outcome._tag) {
      case "Recovered":
        return { state: "created" as const, deployment: outcome.deployment }
      case "Unknown":
        return {
          state: "needs-review" as const,
          reason: outcome.reason,
          candidates: outcome.candidates
        }
      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error({ operation: error.operation, code: error.code, outcome: error.outcome })
    }
    throw error
  } finally {
    await client.close()
  }
}
