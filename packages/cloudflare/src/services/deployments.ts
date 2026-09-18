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
  artifact: Artifact.Artifact
): Effect.Effect<Provider.Deployment, Provider.ProviderError> =>
  Effect.gen(function* () {
    const entries = Artifact.list(artifact)

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

      yield* cloudflare.uploadAssets(jwt, payload)
      // Best effort: failing to warm the cache slows the next deploy, it does
      // not break this one, so it must not fail the publish.
      yield* cloudflare
        .upsertHashes(jwt, [...seen])
        .pipe(Effect.catchTag("CloudflareApiError", () => Effect.void))
    }

    const manifest = Object.fromEntries(hashed.map(file => [`/${file.entry.path}`, file.hash]))

    const deployment = yield* cloudflare.createDeployment(projectName, manifest)
    return toDeployment(deployment, projectName)
  }).pipe(
    Effect.catchTags({
      CloudflareApiError: cause => toProviderError(cause, { appId: projectName }),
      PlatformError: cause => toProviderError(cause, { appId: projectName })
    })
  )
