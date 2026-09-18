/**
 * Reading a deployment back.
 *
 * Separate from deploying because the two run in different places. This is a
 * small HTTP call and a mapping; deploying moves a tree of bytes and needs a
 * hasher and a filesystem. A caller that only polls should not have to bundle
 * those, so nothing here imports them.
 */

import { Effect } from "effect"
import * as Provider from "@deploykit/core/provider"
import { toProviderError } from "./error.js"
import type { VercelClient, VercelDeploymentLike, VercelReadyState } from "./client.js"

const mapReadyState = (readyState: VercelReadyState): Provider.DeploymentStatus => {
  switch (readyState) {
    case "QUEUED":
    case "INITIALIZING":
      return "pending"
    case "BUILDING":
      return "deploying"
    case "READY":
      return "deployed"
    case "ERROR":
    case "CANCELED":
    case "BLOCKED":
      return "failed"
    default: {
      const _exhaustive: never = readyState
      return _exhaustive
    }
  }
}

export const toDeployment = (
  deployment: VercelDeploymentLike,
  fallbackAppId?: string
): Provider.Deployment =>
  Provider.Deployment.make({
    id: Provider.deploymentId.make(String(deployment.id)),
    name: Provider.deploymentName.make(deployment.name ?? String(deployment.id)),
    appId: Provider.appId.make(
      deployment.projectId !== undefined
        ? String(deployment.projectId)
        : (fallbackAppId ?? "unknown")
    ),
    status: mapReadyState(deployment.readyState),
    ...(deployment.readyStateReason !== undefined ? { reason: deployment.readyStateReason } : {}),
    url:
      deployment.url !== undefined
        ? Provider.deploymentUrl.make(`https://${deployment.url}`)
        : undefined
  })

export const getDeployment = (vercel: VercelClient, deploymentId: string) =>
  vercel.getDeployment(deploymentId).pipe(
    Effect.map(deployment => toDeployment(deployment)),
    Effect.mapError(cause => toProviderError(cause, { deploymentId }))
  )
