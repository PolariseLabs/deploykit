import { Effect } from "effect"
import * as Provider from "@deploykit/core/provider"
import type { VercelClient } from "./client.js"
import { toProviderError } from "./error.js"
import { toDeployment } from "./status.js"

/** Point production at a ready production deployment of this project. */
const promote = (client: VercelClient, appId: string, deploymentId: string) =>
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
    Effect.catchTag("VercelApiError", cause => toProviderError(cause, { appId, deploymentId }))
  )

/** Vercel deletes by id alone, so check the deployment belongs to this app and is not live. */
const deleteDeployment = (client: VercelClient, appId: string, deploymentId: string) =>
  Effect.gen(function* () {
    const [deployment, project] = yield* Effect.all(
      [client.getDeployment(deploymentId), client.getProject(appId)],
      { concurrency: 2 }
    )
    if (String(deployment.projectId) !== appId || project.targets?.production?.id === deploymentId)
      return yield* new Provider.UnsupportedError({
        provider: "vercel",
        capability: "deleteDeployment",
        message: "Only this app's deployments that are not serving production can be deleted"
      })
    yield* client.deleteDeployment!(deploymentId)
  }).pipe(
    Effect.catchTag("VercelApiError", cause => toProviderError(cause, { appId, deploymentId }))
  )

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
  ...(client.listDeployments === undefined
    ? {}
    : {
        listDeployments: (appId: string, options: Provider.ListDeploymentsOptions = {}) =>
          client.listDeployments!(appId, {
            limit: Provider.listLimit(options),
            ...(options.target === undefined ? {} : { target: options.target })
          }).pipe(
            Effect.map(deployments => deployments.map(item => toDeployment(item, appId))),
            Effect.catchTag("VercelApiError", cause => toProviderError(cause, { appId }))
          )
      }),
  ...(client.deleteDeployment === undefined
    ? {}
    : {
        deleteDeployment: (appId: string, deploymentId: string) =>
          deleteDeployment(client, appId, deploymentId)
      }),
  ...(client.promoteDeployment === undefined
    ? {}
    : {
        deferredActivation: true,
        activateDeployment: (appId: string, deploymentId: string) =>
          promote(client, appId, deploymentId),
        // Promoting an older ready production deployment is Vercel's rollback.
        rollback: (appId: string, deploymentId: string) => promote(client, appId, deploymentId),
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
