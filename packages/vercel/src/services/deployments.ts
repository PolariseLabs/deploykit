import type { FileSystem, PlatformError } from "effect"
import { Effect, Match } from "effect"
import type { VercelClient, VercelDeploymentLike, VercelReadyState } from "./client.js"
import type { Entry } from "@deploykit/core"
import { Provider, Artifact } from "@deploykit/core"
import { toProviderError } from "./error.js"
import { isMissingDigest, missingShas } from "./client.js"
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
    File: ({ source }) => fs.readFile(source),
    Deferred: entry => Effect.promise(() => entry.read())
  })

/**
 * What the manifest needs about one file, as cheaply as possible.
 *
 * A deferred entry that already knows its sha1 costs nothing: no fetch, no
 * hash. That is the whole performance story, because on a republish most of a
 * tree is unchanged and Vercel already holds those bytes. Everything else has
 * to be read and hashed.
 */
const manifestEntry = (fs: FileSystem.FileSystem, entry: Entry.Entry) =>
  entry._tag === "Deferred" && entry.sha1 !== undefined
    ? Effect.succeed({ file: entry.path, sha: entry.sha1, size: entry.byteLength })
    : bytesOf(fs, entry).pipe(
        Effect.map(bytes => {
          const { sha, size } = digest(bytes)
          return { file: entry.path, sha, size }
        })
      )

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
  /** How many times to answer a missing-bytes rejection. Defaults to 3. */
  readonly uploadRounds?: number
}

export const deployToVercelProject = (
  vercel: VercelClient,
  fs: FileSystem.FileSystem,
  appId: string,
  artifact: Artifact.Artifact,
  options: DeployRequestOptions = {}
): Effect.Effect<Provider.Deployment, Provider.ProviderError> =>
  Effect.gen(function* () {
    const entries = Artifact.list(artifact)

    /**
     * Send the manifest first and upload only what Vercel asks for.
     *
     * Uploading everything up front costs a read and a transfer per file even
     * when Vercel already holds the bytes. On a republish, where the shell,
     * bundles and fonts are unchanged, that is most of the tree. Vercel
     * answers a manifest it cannot resolve with the list of SHAs it is
     * missing, which is a far better question to ask than "what changed".
     */
    const files = yield* Effect.forEach(entries, entry => manifestEntry(fs, entry), {
      concurrency: 8
    })

    const bySha = new Map(files.map((file, index) => [file.sha, entries[index]!]))

    const attempt = (
      round: number
    ): Effect.Effect<Provider.Deployment, Provider.ProviderError | PlatformError.PlatformError> =>
      vercel
        .createDeployment({
          projectId: appId,
          name: appId,
          files,
          target: options.target ?? "production",
          ...(options.meta !== undefined ? { meta: options.meta } : {}),
          ...(options.deploymentId !== undefined ? { deploymentId: options.deploymentId } : {})
        })
        .pipe(
          Effect.map(deployment => toDeployment(deployment, appId)),
          Effect.catchTag("VercelApiError", error => {
            // No list at all with a digest complaint means Vercel holds none of
            // them, which is the ordinary first publish.
            const missing =
              missingShas(error) ??
              (isMissingDigest(error) ? files.map(file => file.sha) : undefined)

            if (missing === undefined || round >= (options.uploadRounds ?? 3)) {
              return Effect.fail(toProviderError(error, { appId }))
            }

            // Distinct shas only: the same bytes at two paths upload once.
            const wanted = [...new Set(missing)].flatMap(sha => {
              const entry = bySha.get(sha)
              return entry === undefined ? [] : [entry]
            })

            return Effect.forEach(wanted, entry => uploadFile(vercel, fs, entry), {
              concurrency: 8
            }).pipe(Effect.andThen(attempt(round + 1)))
          })
        )

    return yield* attempt(0)
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
