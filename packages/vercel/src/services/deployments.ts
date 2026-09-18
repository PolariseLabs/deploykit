import type { FileSystem } from "effect"
import { Effect, Match } from "effect"
import type { VercelClient, VercelDeploymentLike, VercelReadyState } from "./client.js"
import type { Entry } from "@deploykit/core"
import { Provider, Artifact } from "@deploykit/core"
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

    yield* Effect.tryPromise({
      try: () =>
        vercel.deployments.uploadFile({
          contentLength: size,
          xVercelDigest: sha,
          requestBody: bytes
        }),
      catch: error =>
        new Provider.ProviderError({
          message: error instanceof Error ? error.message : "Unknown error",
          provider: "vercel"
        })
    })
    return { file: entry.path, sha, size }
  })

export const deployToVercelProject = (
  vercel: VercelClient,
  fs: FileSystem.FileSystem,
  appId: string,
  artifact: Artifact.Artifact,
  existingDeploymentId?: string
): Effect.Effect<Provider.Deployment, Provider.ProviderError> =>
  Effect.gen(function* () {
    const files = yield* Effect.forEach(
      Artifact.list(artifact),
      entry => uploadFile(vercel, fs, entry),
      {
        concurrency: 8
      }
    )

    const deployment = yield* Effect.tryPromise({
      try: () =>
        vercel.deployments.createDeployment({
          requestBody: {
            project: appId,
            name: appId,
            files,
            ...(existingDeploymentId !== undefined ? { deploymentId: existingDeploymentId } : {})
          }
        }),
      catch: cause =>
        new Provider.ProviderError({
          message: cause instanceof Error ? cause.message : "Unknown error",
          provider: "vercel",
          appId
        })
    })

    return toDeployment(deployment, appId)
  }).pipe(
    Effect.catchTags({
      PlatformError: cause =>
        new Provider.ProviderError({
          message: cause instanceof Error ? cause.message : "Unknown error",
          provider: "vercel",
          appId
        })
    })
  )

export const getDeployment = (vercel: VercelClient, deploymentId: string) =>
  Effect.tryPromise({
    try: () => vercel.deployments.getDeployment({ idOrUrl: deploymentId }),
    catch: cause =>
      new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "vercel",
        deploymentId
      })
  }).pipe(Effect.map(deployment => toDeployment(deployment)))
