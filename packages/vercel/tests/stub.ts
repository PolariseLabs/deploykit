/**
 * A stand-in for the Vercel SDK.
 *
 * The adapter takes a `VercelClient`, which is the four methods it actually
 * calls rather than the whole SDK, so this is a plain object with no casting.
 * Each method records what it was handed, which is how the tests assert on the
 * request the adapter built.
 */

import type {
  VercelClient,
  VercelDeploymentLike,
  VercelProjectLike
} from "../src/services/client.ts"

export interface UploadCall {
  readonly contentLength: number
  readonly xVercelDigest: string
  readonly bytes: Uint8Array
}

export interface StubClient {
  readonly client: VercelClient
  /** Every uploadFile call, in the order the SDK received them. */
  readonly uploads: ReadonlyArray<UploadCall>
  /** Every createDeployment request body. */
  readonly deployRequests: ReadonlyArray<unknown>
  /** Every getProject / createProject request. */
  readonly projectRequests: ReadonlyArray<unknown>
}

export interface StubConfig {
  /** Returned by createDeployment and getDeployment. */
  readonly deployment?: VercelDeploymentLike
  /** Returned by createProject and getProject. */
  readonly project?: VercelProjectLike
  /** When set, every method rejects with this error. */
  readonly rejectWith?: unknown
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
  const deployRequests: Array<unknown> = []
  const projectRequests: Array<unknown> = []

  const deployment = config.deployment ?? defaultDeployment
  const project = config.project ?? defaultProject

  const reject = <A>(): Promise<A> =>
    "rejectWith" in config ? Promise.reject(config.rejectWith) : Promise.resolve(undefined as A)

  const guard = <A>(value: A): Promise<A> =>
    "rejectWith" in config ? reject<A>() : Promise.resolve(value)

  return {
    uploads,
    deployRequests,
    projectRequests,
    client: {
      deployments: {
        uploadFile: request => {
          uploads.push({
            contentLength: request.contentLength ?? 0,
            xVercelDigest: request.xVercelDigest ?? "",
            bytes: request.requestBody as Uint8Array
          })
          return guard<unknown>({})
        },
        createDeployment: request => {
          deployRequests.push(request.requestBody)
          return guard(deployment)
        },
        getDeployment: request => {
          deployRequests.push(request)
          return guard(deployment)
        }
      },
      projects: {
        createProject: request => {
          projectRequests.push(request)
          return guard(project)
        },
        getProject: request => {
          projectRequests.push(request)
          return guard(project)
        },
        deleteProject: request => {
          projectRequests.push(request)
          return guard<void>(undefined)
        }
      }
    }
  }
}
