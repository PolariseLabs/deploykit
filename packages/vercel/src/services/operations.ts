import { Effect } from "effect"
import * as Provider from "@deploykit/core/provider"
import type { VercelClient } from "./client.js"
import { toProviderError } from "./error.js"
import { toDeployment } from "./status.js"

export const operations = (client: VercelClient) => ({
  previewDeployments: true,
  ...(client.findDeployments === undefined
    ? {}
    : {
        reconcileDeployment: (
          appId: string,
          operationId: string
        ): Effect.Effect<Provider.Reconciliation, Provider.ProviderError> =>
          client.findDeployments!(appId, operationId).pipe(
            Effect.map(result =>
              result.complete && result.deployments.length === 1
                ? {
                    _tag: "Recovered" as const,
                    deployment: toDeployment(result.deployments[0]!, appId)
                  }
                : {
                    _tag: "Unknown" as const,
                    candidates: result.deployments.map(item => String(item.id)),
                    reason: result.complete
                      ? "No unique matching deployment"
                      : "Search window is incomplete"
                  }
            ),
            Effect.mapError(cause => toProviderError(cause, { appId }))
          )
      }),
  ...(client.promoteDeployment === undefined
    ? {}
    : {
        deferredActivation: true,
        activateDeployment: (appId: string, deploymentId: string) =>
          Effect.gen(function* () {
            const deployment = yield* client.getDeployment(deploymentId)
            if (
              deployment.target !== "production" ||
              deployment.readyState !== "READY" ||
              deployment.projectId !== appId
            ) {
              return yield* new Provider.UnsupportedError({
                provider: "vercel",
                capability: "activation",
                message: "Activation requires a ready production deployment belonging to this app"
              })
            }
            yield* client.promoteDeployment!(appId, deploymentId)
            return { appId, deploymentId, state: "pending" as const }
          }).pipe(
            Effect.catchTag("VercelApiError", cause =>
              toProviderError(cause, { appId, deploymentId })
            )
          ),
        getActivation: (appId: string, deploymentId: string) =>
          client.getProject(appId).pipe(
            Effect.map(project => ({
              appId,
              deploymentId,
              state:
                project.targets?.production?.id === deploymentId
                  ? ("active" as const)
                  : ("unknown" as const)
            })),
            Effect.mapError(cause => toProviderError(cause, { appId, deploymentId }))
          )
      })
})
