/**
 * A stand-in for Vercel's API.
 *
 * The adapter depends on `VercelClient`, which is the six calls it actually
 * makes, so this is a plain object with no casting. Every method records what
 * it was handed, which is how the tests assert on the request that was built.
 */

import { Effect } from "effect"
import {
  VercelApiError,
  type CreateDeploymentRequest,
  type VercelClient,
  type VercelDeploymentLike,
  type VercelProjectLike
} from "../src/services/client.ts"

export interface UploadCall {
  readonly sha: string
  readonly bytes: Uint8Array
}

export interface StubClient {
  readonly client: VercelClient
  /** Every uploadFile call, in the order the client made them. */
  readonly uploads: ReadonlyArray<UploadCall>
  /** Every createDeployment request. */
  readonly deployRequests: ReadonlyArray<CreateDeploymentRequest>
  /** Every project call, as `{ op, arg }`. */
  readonly projectCalls: ReadonlyArray<{ readonly op: string; readonly arg: string }>
}

export interface StubConfig {
  readonly deployment?: VercelDeploymentLike
  readonly project?: VercelProjectLike
  /** Every call fails with this status. */
  readonly failWithStatus?: number
  /** Body returned alongside `failWithStatus`. */
  readonly failWithBody?: string
  /** Seconds, as Vercel would send in Retry-After. */
  readonly retryAfterSeconds?: number
  /** Every call fails before reaching the server, so there is no status. */
  readonly failWithoutResponse?: string
}

const defaultDeployment: VercelDeploymentLike = {
  id: "dpl_1",
  readyState: "QUEUED",
  name: "alpha",
  projectId: "prj_1",
  url: "alpha-abc.vercel.app"
}

const defaultProject: VercelProjectLike = { id: "prj_1", name: "alpha" }

export const stubClient = (config: StubConfig = {}): StubClient => {
  const uploads: Array<UploadCall> = []
  const deployRequests: Array<CreateDeploymentRequest> = []
  const projectCalls: Array<{ op: string; arg: string }> = []

  const deployment = config.deployment ?? defaultDeployment
  const project = config.project ?? defaultProject

  const failure = (operation: string) => {
    if (config.failWithoutResponse !== undefined) {
      return new VercelApiError({ operation, message: config.failWithoutResponse })
    }
    return new VercelApiError({
      operation,
      message: `${operation} failed: HTTP ${config.failWithStatus}`,
      statusCode: config.failWithStatus ?? 500,
      ...(config.failWithBody !== undefined ? { body: config.failWithBody } : {}),
      ...(config.retryAfterSeconds !== undefined
        ? { retryAfterMs: config.retryAfterSeconds * 1000 }
        : {})
    })
  }

  const shouldFail = config.failWithStatus !== undefined || config.failWithoutResponse !== undefined

  const guard = <A>(operation: string, value: A): Effect.Effect<A, VercelApiError> =>
    shouldFail ? Effect.fail(failure(operation)) : Effect.succeed(value)

  return {
    uploads,
    deployRequests,
    projectCalls,
    client: {
      createProject: name => {
        projectCalls.push({ op: "createProject", arg: name })
        return guard("createProject", project)
      },
      getProject: idOrName => {
        projectCalls.push({ op: "getProject", arg: idOrName })
        return guard("getProject", project)
      },
      deleteProject: idOrName => {
        projectCalls.push({ op: "deleteProject", arg: idOrName })
        return guard<void>("deleteProject", undefined)
      },
      uploadFile: (sha, bytes) => {
        uploads.push({ sha, bytes })
        return guard<void>("uploadFile", undefined)
      },
      createDeployment: request => {
        deployRequests.push(request)
        return guard("createDeployment", deployment)
      },
      getDeployment: idOrUrl => {
        projectCalls.push({ op: "getDeployment", arg: idOrUrl })
        return guard("getDeployment", deployment)
      },
      setProjectAccess: (idOrName, access) => {
        projectCalls.push({ op: `setProjectAccess:${access._tag}`, arg: idOrName })
        return guard<void>("setProjectAccess", undefined)
      }
    }
  }
}
