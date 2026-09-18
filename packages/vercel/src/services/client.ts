/**
 * The slice of the Vercel SDK this adapter actually touches.
 *
 * Depending on four methods rather than the whole `Vercel` class documents what
 * the adapter needs, and lets a test supply a stub without standing up the SDK
 * or reaching the network. The request types are taken from the SDK itself, so
 * they cannot drift; only the responses are narrowed, to the handful of fields
 * this adapter reads.
 */

import type { Vercel } from "@vercel/sdk"

/**
 * The deployment states the Vercel SDK can return from createDeployment and
 * getDeployment. Kept as a union, not `string`, so the switch that maps it is
 * checked: if Vercel adds a state, adding it here turns the gap into a compile
 * error. A value outside this set fails the SDK's own response parsing first,
 * which surfaces as a ProviderError rather than reaching the mapping.
 */
export type VercelReadyState =
  "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "BLOCKED"

/** The fields this adapter reads off a Vercel deployment. */
export interface VercelDeploymentLike {
  readonly id: string | number
  readonly readyState: VercelReadyState
  readonly name?: string
  readonly projectId?: string | number
  readonly url?: string
}

/** The fields this adapter reads off a Vercel project. */
export interface VercelProjectLike {
  readonly id: string
  readonly name: string
}

type Request<T extends (...args: never) => unknown> = Parameters<T>[0]

export interface VercelClient {
  readonly deployments: {
    readonly uploadFile: (request: Request<Vercel["deployments"]["uploadFile"]>) => Promise<unknown>
    readonly createDeployment: (
      request: Request<Vercel["deployments"]["createDeployment"]>
    ) => Promise<VercelDeploymentLike>
    readonly getDeployment: (
      request: Request<Vercel["deployments"]["getDeployment"]>
    ) => Promise<VercelDeploymentLike>
  }
  readonly projects: {
    readonly createProject: (
      request: Request<Vercel["projects"]["createProject"]>
    ) => Promise<VercelProjectLike>
    readonly getProject: (
      request: Request<Vercel["projects"]["getProject"]>
    ) => Promise<VercelProjectLike>
    readonly deleteProject: (request: Request<Vercel["projects"]["deleteProject"]>) => Promise<void>
  }
}
