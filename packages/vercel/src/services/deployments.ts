import type { FileSystem, PlatformError } from "effect"
import { Effect, Match } from "effect"
import type { VercelClient } from "./client.js"
import type { Entry, Provider } from "@deploykit/core"
import { Artifact } from "@deploykit/core"
import { toProviderError } from "./error.js"
import { isMissingDigest, missingShas } from "./client.js"
import { toDeployment } from "./status.js"
import { createHash } from "node:crypto"

const digest = (bytes: Uint8Array) => {
  const sha = createHash("sha1").update(bytes).digest("hex")
  const size = bytes.byteLength
  return { sha, size }
}

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
/** The digest Vercel addresses uploads by: hex sha1 of the raw bytes. */
const VERCEL_DIGEST = "sha1"

const manifestEntry = (fs: FileSystem.FileSystem, entry: Entry.Entry) =>
  entry._tag === "Deferred" && entry.digests?.[VERCEL_DIGEST] !== undefined
    ? Effect.succeed({
        file: entry.path,
        sha: entry.digests[VERCEL_DIGEST],
        size: entry.byteLength
      })
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

/** Vercel's own extras, on top of the portable options. */
export interface DeployRequestOptions extends Provider.DeployOptions {
  /** How many times to answer a missing-bytes rejection. Defaults to 3. */
  readonly uploadRounds?: number
}

/** Progress reporting must never be the reason a deploy fails. */
const report = (
  options: DeployRequestOptions,
  event: Provider.DeployProgress
): Effect.Effect<void> =>
  options.onProgress === undefined
    ? Effect.void
    : options.onProgress(event).pipe(Effect.catchCause(() => Effect.void))

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
    yield* report(options, { _tag: "Hashing", done: 0, total: entries.length })
    const files = yield* Effect.forEach(entries, entry => manifestEntry(fs, entry), {
      concurrency: 8
    })
    yield* report(options, { _tag: "Hashing", done: entries.length, total: entries.length })

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
          ...(options.meta !== undefined ? { meta: options.meta } : {})
        })
        .pipe(
          Effect.tap(deployment =>
            report(options, { _tag: "Created", deploymentId: String(deployment.id) })
          ),
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
            if (error.statusCode === 429) {
              void report(options, {
                _tag: "Throttled",
                ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
              })
            }

            // Distinct shas only: the same bytes at two paths upload once.
            const wanted = [...new Set(missing)].flatMap(sha => {
              const entry = bySha.get(sha)
              return entry === undefined ? [] : [entry]
            })

            const bytes = wanted.reduce((total, entry) => total + Artifact.sizeOf(entry), 0)
            return report(options, {
              _tag: "Uploading",
              done: 0,
              total: wanted.length,
              bytes
            }).pipe(
              Effect.andThen(
                Effect.forEach(wanted, entry => uploadFile(vercel, fs, entry), {
                  concurrency: 8
                })
              ),
              Effect.andThen(
                report(options, {
                  _tag: "Uploading",
                  done: wanted.length,
                  total: wanted.length,
                  bytes
                })
              ),
              Effect.andThen(attempt(round + 1))
            )
          })
        )

    return yield* attempt(0)
  }).pipe(
    Effect.catchTags({
      PlatformError: cause => toProviderError(cause, { appId })
    })
  )
