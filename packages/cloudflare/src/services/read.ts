/** Reading a deployment back: one HTTP call and the stage mapping, no bytes. */

import { Effect } from "effect"
import { toDeployment } from "./status.js"
import { toProviderError } from "./error.js"
import type { CloudflareClient } from "./client.js"

export const getPagesDeployment = (
  cloudflare: CloudflareClient,
  projectName: string,
  deploymentId: string
) =>
  cloudflare.getDeployment(projectName, deploymentId).pipe(
    Effect.map(deployment => toDeployment(deployment, projectName)),
    Effect.mapError(cause => toProviderError(cause, { deploymentId, appId: projectName }))
  )
