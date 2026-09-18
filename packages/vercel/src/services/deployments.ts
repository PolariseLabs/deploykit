import type { FileSystem } from "effect"
import { Effect, Match } from "effect"
import type { VercelClient, VercelDeploymentLike, VercelReadyState } from "./client.js"
import type { Entry } from "@deploykit/core"
import { Provider, Artifact } from "@deploykit/core"
import { toProviderError } from "./error.js"
import { createHash } from "node:crypto"

const digest = (bytes: Uint8Array) => {
  const sha = createHash("sha1").update(bytes).digest("hex")
  const size = bytes.byteLength
  return { sha, size }
}

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

const toDeployment = (
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

export const bytesOf = (fs: FileSystem.FileSystem, entry: Entry.Entry) =>
  Match.valueTags(entry, {
    Text: ({ content }) => Effect.succeed(new TextEncoder().encode(content)),
    Bytes: ({ content }) => Effect.succeed(content),
    File: ({ source }) => fs.readFile(source)
  })

export const uploadFile = (vercel: VercelClient, fs: FileSystem.FileSystem, entry: Entry.Entry) =>
  Effect.gen(function* () {
    const bytes = yield* bytesOf(fs, entry)

    const { sha, size } = digest(bytes)

    yield* vercel.uploadFile(sha, bytes).pipe(Effect.mapError(cause => toProviderError(cause)))
    return { file: entry.path, sha, size }
  })

/** What a caller can vary about one deployment. */
export interface DeployRequestOptions {
  /** Defaults to production, as a publish normally means the live slot. */
  readonly target?: "production" | "preview"
  /** Carried through to Vercel, for linking a deployment back to a release. */
  readonly meta?: Readonly<Record<string, string>>
  /** Continues an existing deployment rather than starting a new one. */
  readonly deploymentId?: string
}

export const deployToVercelProject = (
  vercel: VercelClient,
  fs: FileSystem.FileSystem,
  appId: string,
  artifact: Artifact.Artifact,
  options: DeployRequestOptions = {}
): Effect.Effect<Provider.Deployment, Provider.ProviderError> =>
  Effect.gen(function* () {
    const files = yield* Effect.forEach(
      Artifact.list(artifact),
      entry => uploadFile(vercel, fs, entry),
      {
        concurrency: 8
      }
    )

    const deployment = yield* vercel
      .createDeployment({
        projectId: appId,
        name: appId,
        files,
        target: options.target ?? "production",
        ...(options.meta !== undefined ? { meta: options.meta } : {}),
        ...(options.deploymentId !== undefined ? { deploymentId: options.deploymentId } : {})
      })
      .pipe(Effect.mapError(cause => toProviderError(cause, { appId })))

    return toDeployment(deployment, appId)
  }).pipe(
    Effect.catchTags({
      PlatformError: cause => toProviderError(cause, { appId })
    })
  )

export const getDeployment = (vercel: VercelClient, deploymentId: string) =>
  vercel.getDeployment(deploymentId).pipe(
    Effect.map(deployment => toDeployment(deployment)),
    Effect.mapError(cause => toProviderError(cause, { deploymentId }))
  )
