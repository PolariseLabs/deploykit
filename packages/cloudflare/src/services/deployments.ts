/**
 * Deploying an artifact to Cloudflare Pages.
 *
 * Four steps where Vercel has two, and one of them is better: Cloudflare has
 * a `check-missing` endpoint, so asking what it already holds is a first-class
 * question rather than something you learn from a rejected deployment.
 *
 *   upload-token -> check-missing -> upload the misses -> create with a manifest
 *
 * The manifest maps a leading-slash path to the hash holding its bytes, which
 * is why the same bytes at two paths upload once but appear twice.
 */

import { Effect, Match } from "effect"
import type { FileSystem } from "effect"
import type * as Provider from "@deploykit/core/provider"
import * as Artifact from "@deploykit/core/artifact"
import type * as Entry from "@deploykit/core/entry"
import { CLOUDFLARE_DIGEST, pagesDigest } from "./digest.js"
import { toDeployment } from "./status.js"
import { WORKER_PATH, workerBundle } from "./worker.js"
import { toProviderError } from "./error.js"
import type { AssetUpload, CloudflareClient } from "./client.js"

/** Enough to be useful; Cloudflare serves by extension anyway. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  woff2: "font/woff2",
  wasm: "application/wasm"
}

const contentTypeOf = (path: string): string => {
  const dot = path.lastIndexOf(".")
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

const bytesOf = (fs: FileSystem.FileSystem, entry: Entry.Entry) =>
  Match.valueTags(entry, {
    Text: e => Effect.succeed(new TextEncoder().encode(e.content)),
    Bytes: e => Effect.succeed(e.content),
    File: e => fs.readFile(e.source),
    Deferred: e => Effect.promise(() => e.read())
  })

export const deployToPagesProject = (
  cloudflare: CloudflareClient,
  fs: FileSystem.FileSystem,
  projectName: string,
  artifact: Artifact.Artifact,
  options: Provider.DeployOptions = {}
): Effect.Effect<Provider.Deployment, Provider.ProviderError> =>
  Effect.gen(function* () {
    /**
     * `_worker.js` is lifted out rather than uploaded.
     *
     * Pages treats it as the Function, not as a file to serve, and an asset
     * by that name is silently ignored. Taking it from the artifact means a
     * caller lays out the tree exactly as Pages expects on disk and the
     * adapter does the rest.
     */
    const all = Artifact.list(artifact)
    const workerEntry = all.find(entry => entry.path === WORKER_PATH)
    const entries = all.filter(entry => entry.path !== WORKER_PATH)

    const report = (event: Provider.DeployProgress) =>
      options.onProgress === undefined
        ? Effect.void
        : options.onProgress(event).pipe(Effect.catchCause(() => Effect.void))

    yield* report({ _tag: "Hashing", done: 0, total: entries.length })

    /**
     * A deferred entry that already carries this provider's digest never gets
     * read. The key is provider-specific on purpose: a sha1 stored for Vercel
     * says nothing here, because Cloudflare hashes the extension in too.
     */
    const hashed = yield* Effect.forEach(
      entries,
      entry =>
        entry._tag === "Deferred" && entry.digests?.[CLOUDFLARE_DIGEST] !== undefined
          ? Effect.succeed({ entry, hash: entry.digests[CLOUDFLARE_DIGEST] })
          : bytesOf(fs, entry).pipe(
              Effect.map(bytes => ({ entry, hash: pagesDigest(bytes, entry.path) }))
            ),
      { concurrency: 8 }
    )

    yield* report({ _tag: "Hashing", done: entries.length, total: entries.length })

    const jwt = yield* cloudflare.uploadToken(projectName)

    const missing = new Set(
      yield* cloudflare.checkMissing(jwt, [...new Set(hashed.map(file => file.hash))])
    )

    // Distinct hashes only: the same bytes at two paths upload once.
    const seen = new Set<string>()
    const toUpload = hashed.filter(file => {
      if (!missing.has(file.hash) || seen.has(file.hash)) return false
      seen.add(file.hash)
      return true
    })

    if (toUpload.length > 0) {
      const payload: ReadonlyArray<AssetUpload> = yield* Effect.forEach(
        toUpload,
        file =>
          bytesOf(fs, file.entry).pipe(
            Effect.map(bytes => {
              let binary = ""
              for (const byte of bytes) binary += String.fromCharCode(byte)
              return {
                key: file.hash,
                value: btoa(binary),
                metadata: { contentType: contentTypeOf(file.entry.path) },
                base64: true as const
              }
            })
          ),
        { concurrency: 4 }
      )

      const bytes = toUpload.reduce((total, file) => total + Artifact.sizeOf(file.entry), 0)
      yield* report({ _tag: "Uploading", done: 0, total: toUpload.length, bytes })
      yield* cloudflare.uploadAssets(jwt, payload)
      yield* report({ _tag: "Uploading", done: toUpload.length, total: toUpload.length, bytes })
      // Best effort: failing to warm the cache slows the next deploy, it does
      // not break this one, so it must not fail the publish.
      yield* cloudflare
        .upsertHashes(jwt, [...seen])
        .pipe(Effect.catchTag("CloudflareApiError", () => Effect.void))
    }

    const manifest = Object.fromEntries(hashed.map(file => [`/${file.entry.path}`, file.hash]))

    /**
     * Pages has no equivalent of Vercel's target, meta or deployment resume.
     * A deployment belongs to a branch, and there is no way to attach
     * arbitrary metadata or to continue one that was already started. Ignored
     * rather than faked: a caller reads capabilities, not guesses.
     */
    const bundle =
      workerEntry === undefined
        ? undefined
        : yield* bytesOf(fs, workerEntry).pipe(
            Effect.flatMap(bytes =>
              Effect.promise(() =>
                workerBundle({
                  main: { name: "index.js", content: new TextDecoder().decode(bytes) }
                })
              )
            )
          )

    const deployment = yield* cloudflare.createDeployment(
      projectName,
      manifest,
      bundle === undefined ? undefined : { workerBundle: bundle }
    )
    yield* report({ _tag: "Created", deploymentId: deployment.id })
    return toDeployment(deployment, projectName)
  }).pipe(
    Effect.catchTags({
      CloudflareApiError: cause => toProviderError(cause, { appId: projectName }),
      PlatformError: cause => toProviderError(cause, { appId: projectName })
    })
  )
