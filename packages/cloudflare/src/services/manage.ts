/** Listing, deleting and rolling back deployments that already exist. */

import { Effect } from "effect"
import * as Provider from "@deploykit/core/provider"
import type { CloudflareClient } from "./client.js"
import { toProviderError } from "./error.js"
import { toDeployment } from "./status.js"

export const listPagesDeployments = (
  cloudflare: CloudflareClient,
  projectName: string,
  options: Provider.ListDeploymentsOptions = {}
) =>
  cloudflare.listDeployments!(projectName, {
    perPage: Provider.listLimit(options),
    ...(options.target === undefined ? {} : { env: options.target })
  }).pipe(
    Effect.map(deployments => deployments.map(item => toDeployment(item, projectName))),
    Effect.mapError(cause => toProviderError(cause, { appId: projectName }))
  )

/** Refuses the deployment serving production, rather than relying on Pages to. */
export const deletePagesDeployment = (
  cloudflare: CloudflareClient,
  projectName: string,
  deploymentId: string
) =>
  Effect.gen(function* () {
    const project = yield* cloudflare.getProject(projectName)
    if (project.canonical_deployment?.id === deploymentId)
      return yield* new Provider.UnsupportedError({
        provider: "cloudflare",
        capability: "deleteDeployment",
        message: "The deployment serving production cannot be deleted"
      })
    yield* cloudflare.deleteDeployment!(projectName, deploymentId)
  }).pipe(
    Effect.catchTag("CloudflareApiError", cause =>
      toProviderError(cause, { appId: projectName, deploymentId })
    )
  )

/** Pages switches production as soon as the rollback call succeeds. */
export const rollbackPagesDeployment = (
  cloudflare: CloudflareClient,
  projectName: string,
  deploymentId: string
) =>
  cloudflare.rollbackDeployment!(projectName, deploymentId).pipe(
    Effect.as({ appId: projectName, deploymentId, state: "active" as const }),
    Effect.mapError(cause => toProviderError(cause, { appId: projectName, deploymentId }))
  )
